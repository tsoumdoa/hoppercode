import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import type { HopperRpcRequest, OperationResultSnapshot } from "../protocol/v2.js";
import {
	HopperRpcClient,
	RpcDisconnectedError,
	RpcProtocolError,
	RpcTimeoutError,
	type DealerSocket,
	type DealerSocketFactory,
	type RpcClock,
} from "./rpc-client.js";

const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const LIFECYCLE_ID = "life-test-1";

type ReceiveWaiter = {
	resolve: (frames: readonly Uint8Array[]) => void;
	reject: (error: Error) => void;
};

class FakeDealerSocket implements DealerSocket {
	readonly sent: HopperRpcRequest[] = [];
	endpoint: string | null = null;
	closed = false;
	sendErrorAfterRecord: Error | null = null;
	private waiter: ReceiveWaiter | null = null;
	private events: Array<{ frames: readonly Uint8Array[] } | { error: Error }> = [];

	connect(endpoint: string): void {
		this.endpoint = endpoint;
	}

	send(payload: Uint8Array): void {
		if (this.closed) throw new Error("socket closed");
		this.sent.push(JSON.parse(new TextDecoder().decode(payload)) as HopperRpcRequest);
		if (this.sendErrorAfterRecord) throw this.sendErrorAfterRecord;
	}

	receive(): Promise<readonly Uint8Array[]> {
		if (this.closed) return Promise.reject(new Error("socket closed"));
		const event = this.events.shift();
		if (event) return "error" in event ? Promise.reject(event.error) : Promise.resolve(event.frames);
		return new Promise((resolve, reject) => {
			this.waiter = { resolve, reject };
		});
	}

	close(): void {
		this.closed = true;
		this.waiter?.reject(new Error("socket closed"));
		this.waiter = null;
	}

	respond(value: unknown): void {
		const frames = [new TextEncoder().encode(JSON.stringify(value))];
		if (this.waiter) {
			const waiter = this.waiter;
			this.waiter = null;
			waiter.resolve(frames);
		} else {
			this.events.push({ frames });
		}
	}

	disconnect(message = "connection lost"): void {
		const error = new Error(message);
		if (this.waiter) {
			const waiter = this.waiter;
			this.waiter = null;
			waiter.reject(error);
		} else {
			this.events.push({ error });
		}
	}
}

class FakeDealerFactory implements DealerSocketFactory {
	readonly identities: string[] = [];
	readonly sockets: FakeDealerSocket[] = [];
	readonly sendErrors: Array<Error | null> = [];

	create(identity: string): DealerSocket {
		this.identities.push(identity);
		const socket = new FakeDealerSocket();
		socket.sendErrorAfterRecord = this.sendErrors.shift() ?? null;
		this.sockets.push(socket);
		return socket;
	}
}

class FakeClock implements RpcClock {
	private time = 1_730_000_000_000;
	private nextId = 1;
	private timers = new Map<number, { at: number; callback: () => void }>();

	now(): number {
		return this.time;
	}

	setTimeout(callback: () => void, delayMs: number): unknown {
		const id = this.nextId++;
		this.timers.set(id, { at: this.time + delayMs, callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	advance(delayMs: number): void {
		this.time += delayMs;
		while (true) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= this.time)
				.sort((left, right) => left[1].at - right[1].at)[0];
			if (!due) return;
			this.timers.delete(due[0]);
			due[1].callback();
		}
	}
}

function sequentialIds(prefix: string): () => string {
	let value = 0;
	return () => `${prefix}-${++value}`;
}

function createClient(overrides: Partial<ConstructorParameters<typeof HopperRpcClient>[0]> = {}) {
	const factory = overrides.socketFactory instanceof FakeDealerFactory
		? overrides.socketFactory
		: new FakeDealerFactory();
	const clock = new FakeClock();
	const client = new HopperRpcClient({
		endpoint: "tcp://127.0.0.1:5557",
		lifecycleInstanceId: LIFECYCLE_ID,
		token: TOKEN,
		identity: "hopper-node-test-process",
		socketFactory: factory,
		clock,
		requestIdFactory: sequentialIds("req"),
		operationIdFactory: sequentialIds("op"),
		sleep: async () => {},
		...overrides,
	});
	return { client, factory, clock };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => queueMicrotask(resolve));
	}
	throw new Error("condition was not reached");
}

function operationResponse(request: HopperRpcRequest, result: OperationResultSnapshot) {
	return {
		protocolVersion: 2,
		lifecycleInstanceId: request.lifecycleInstanceId,
		requestId: request.requestId,
		operation: request.operation,
		...("operationId" in request ? { operationId: request.operationId } : {}),
		result,
	};
}

describe("HopperRpcClient", () => {
	it("multiplexes concurrent calls and resolves out-of-order replies", async () => {
		const { client, factory, clock } = createClient({ defaultStartDeadlineMs: 25_000 });
		const first = client.call("getCurrentCanvas", { selectionOnly: false });
		const second = client.call("queryRhinoObjects", { layer: "Structure" });
		await waitFor(() => factory.sockets[0]?.sent.length === 2);

		const socket = factory.sockets[0];
		const [firstRequest, secondRequest] = socket.sent;
		assert.equal(firstRequest.startDeadlineAt, clock.now() + 25_000);
		assert.equal(firstRequest.token, TOKEN);
		assert.equal(firstRequest.lifecycleInstanceId, LIFECYCLE_ID);
		assert.equal(factory.identities[0], "hopper-node-test-process");

		socket.respond(operationResponse(secondRequest, {
			class: "completed", reasonCode: "OK", data: { marker: "second" },
		}));
		socket.respond(operationResponse(firstRequest, {
			class: "completed", reasonCode: "OK", data: { marker: "first" },
		}));

		const [firstResult, secondResult] = await Promise.all([first, second]);
		assert.ok(!("source" in firstResult));
		assert.ok(!("source" in secondResult));
		assert.deepEqual(firstResult.result.data, { marker: "first" });
		assert.deepEqual(secondResult.result.data, { marker: "second" });
		assert.equal(client.pendingCount, 0);
		await client.close();
	});

	it("reconnects with the same identity after a query disconnect", async () => {
		const { client, factory } = createClient();
		const first = client.call("getCurrentCanvas", {});
		const rejected = expect(first).rejects.toBeInstanceOf(RpcDisconnectedError);
		await waitFor(() => factory.sockets[0]?.sent.length === 1);
		factory.sockets[0].disconnect();
		await rejected;

		const second = client.call("getCurrentCanvas", {});
		await waitFor(() => factory.sockets[1]?.sent.length === 1);
		const request = factory.sockets[1].sent[0];
		factory.sockets[1].respond(operationResponse(request, {
			class: "completed", reasonCode: "OK", data: { reconnected: true },
		}));
		await second;
		assert.deepEqual(factory.identities, ["hopper-node-test-process", "hopper-node-test-process"]);
		await client.close();
	});

	it("recovers a lost mutation reply by lookup without resubmitting", async () => {
		const { client, factory } = createClient();
		const mutation = client.call("setSliderValue", { targetId: "slider-1", value: 4.5 });
		await waitFor(() => factory.sockets[0]?.sent.length === 1);
		const original = factory.sockets[0].sent[0];
		assert.equal(original.operation, "setSliderValue");
		assert.equal("operationId" in original && original.operationId, "op-1");

		factory.sockets[0].disconnect("reply path lost");
		await waitFor(() => factory.sockets[1]?.sent.length === 1);
		const lookup = factory.sockets[1].sent[0];
		assert.equal(lookup.operation, "getOperationResult");
		assert.deepEqual(lookup.args, { operationId: "op-1" });
		assert.equal(factory.sockets.flatMap((socket) => socket.sent)
			.filter((request) => request.operation === "setSliderValue").length, 1);

		factory.sockets[1].respond(operationResponse(lookup, {
			class: "completed",
			reasonCode: "OK",
			data: { state: "pending", phase: "running" },
		}));
		await waitFor(() => factory.sockets[1].sent.length === 2);
		const secondLookup = factory.sockets[1].sent[1];
		assert.equal(secondLookup.operation, "getOperationResult");
		assert.deepEqual(secondLookup.args, { operationId: "op-1" });
		assert.equal(factory.sockets.flatMap((socket) => socket.sent)
			.filter((request) => request.operation === "setSliderValue").length, 1);

		factory.sockets[1].respond(operationResponse(secondLookup, {
			class: "completed",
			reasonCode: "OK",
			data: {
				state: "terminal",
				result: { class: "completed", reasonCode: "OK", data: { changed: true } },
			},
		}));

		const result = await mutation;
		assert.ok(!("source" in result));
		assert.equal(result.operation, "setSliderValue");
		assert.equal(result.operationId, "op-1");
		assert.deepEqual(result.result.data, { changed: true });
		assert.deepEqual(factory.identities, ["hopper-node-test-process", "hopper-node-test-process"]);
		await client.close();
	});

	it("treats a send failure after submission as ambiguous and only performs lookup", async () => {
		const factory = new FakeDealerFactory();
		factory.sendErrors.push(new Error("send failed after ZeroMQ accepted the frame"));
		const { client } = createClient({ socketFactory: factory });
		const mutation = client.call("setSliderValue", { targetId: "slider-1", value: 7 });

		await waitFor(() => factory.sockets[1]?.sent.length === 1);
		const lookup = factory.sockets[1].sent[0];
		assert.equal(lookup.operation, "getOperationResult");
		assert.deepEqual(lookup.args, { operationId: "op-1" });
		assert.equal(factory.sockets.flatMap((socket) => socket.sent)
			.filter((request) => request.operation === "setSliderValue").length, 1);
		assert.deepEqual(factory.identities, ["hopper-node-test-process", "hopper-node-test-process"]);

		factory.sockets[1].respond(operationResponse(lookup, {
			class: "completed",
			reasonCode: "OK",
			data: {
				state: "terminal",
				result: { class: "completed", reasonCode: "OK", data: { changed: true } },
			},
		}));

		const result = await mutation;
		assert.ok(!("source" in result));
		assert.equal(result.operation, "setSliderValue");
		assert.deepEqual(result.result.data, { changed: true });
		assert.equal(factory.sockets.flatMap((socket) => socket.sent)
			.filter((request) => request.operation === "setSliderValue").length, 1);
		await client.close();
	});

	it("returns Node-local outcome_unknown when a sent mutation times out", async () => {
		const { client, factory, clock } = createClient();
		const mutation = client.call("setSliderValue", { targetId: "slider-1", value: 4.5 }, {
			completionTimeoutMs: 100,
		});
		await waitFor(() => factory.sockets[0]?.sent.length === 1);
		clock.advance(100);

		const result = await mutation;
		assert.ok("source" in result);
		assert.equal(result.source, "node");
		assert.equal(result.result.class, "outcome_unknown");
		assert.equal(result.operationId, "op-1");
		assert.deepEqual(factory.sockets[0].sent.map((request) => request.operation), ["setSliderValue"]);
		await client.close();
	});

	it("rejects a timed-out query without claiming cancellation", async () => {
		const { client, factory, clock } = createClient();
		const query = client.call("getCurrentCanvas", {}, { completionTimeoutMs: 100 });
		const rejected = expect(query).rejects.toBeInstanceOf(RpcTimeoutError);
		await waitFor(() => factory.sockets[0]?.sent.length === 1);
		clock.advance(100);
		await rejected;
		assert.deepEqual(factory.sockets[0].sent.map((request) => request.operation), ["getCurrentCanvas"]);
		await client.close();
	});

	it("rejects correlated protocol errors with their reason code", async () => {
		const { client, factory } = createClient();
		const query = client.call("getCurrentCanvas", {});
		await waitFor(() => factory.sockets[0]?.sent.length === 1);
		const request = factory.sockets[0].sent[0];
		factory.sockets[0].respond({
			protocolVersion: 2,
			requestId: request.requestId,
			errorType: "protocol_error",
			lifecycleInstanceId: request.lifecycleInstanceId,
			operation: request.operation,
			result: {
				class: "failed",
				reasonCode: "AUTH_INVALID",
				message: "Authentication failed.",
			},
		});

		try {
			await query;
			assert.fail("query should reject");
		} catch (error) {
			assert.ok(error instanceof RpcProtocolError);
			assert.equal(error.reasonCode, "AUTH_INVALID");
			assert.equal(error.requestId, request.requestId);
		}
		await client.close();
	});
});

it("honors a tool abort immediately before transport send without claiming native cancellation", async () => {
	const sockets = new FakeDealerFactory();
	const client = new HopperRpcClient({
		endpoint: "inproc://abort",
		lifecycleInstanceId: LIFECYCLE_ID,
		token: TOKEN,
		socketFactory: sockets,
	});
	const signal = new AbortController();
	const resultPromise = client.call(
		"runRhinoScript",
		{ mode: "python", source: "print(1)" },
		{ operationId: "abort-run", signal: signal.signal },
	);
	signal.abort();
	const result = await resultPromise;
	expect(result.result.class).toBe("cancelled_before_start");
	expect(sockets.sockets.flatMap((socket) => socket.sent)).toHaveLength(0);
	await client.close();
});
