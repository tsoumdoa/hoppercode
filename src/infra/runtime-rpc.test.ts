import { describe, expect, it, vi } from "vitest";
import type {
	OperationName,
	RequestArgsFor,
	RpcOperationResponse,
	RuntimeStatus,
} from "../protocol/v2.js";
import type {
	NodeLocalOutcomeUnknown,
	RpcCallOptions,
	RpcCallResult,
} from "./rpc-client.js";
import type { RuntimeStatusEventSource } from "./grasshopper-readiness.js";
import {
	beginRuntimeAgentTurn,
	commitRuntimeAgentTurn,
	RpcOutcomeUnknownError,
	resetRuntimeRpcForTests,
	RuntimeRpc,
	type RuntimeRpcTransport,
} from "./runtime-rpc.js";
import { Requester } from "./requester.js";

const LIFE = "life-runtime-1";

describe("RuntimeRpc", () => {
	it("tracks an empty turn without resolving a connection profile", async () => {
		await resetRuntimeRpcForTests();

		expect(() => beginRuntimeAgentTurn()).not.toThrow();
		await expect(commitRuntimeAgentTurn()).resolves.toBeUndefined();
	});

	it("returns Rhino's runtime status object unchanged", async () => {
		const snapshot = status("ready", true, 17);
		const transport = new FakeTransport((operation) => response(
			operation,
			operation === "lifecycleHandshake"
				? { handshake: "live", statusRevision: 17 }
				: snapshot,
		));
		const runtime = runtimeWith(transport, new FakeEvents());

		const result = await runtime.getRuntimeStatus();

		expect(result).toBe(snapshot);
	});

	it("retries only transient handshake identity registration rejections", async () => {
		let now = 0;
		let attempts = 0;
		const sleeps: number[] = [];
		const transport = new FakeTransport((operation) => {
			if (operation !== "lifecycleHandshake") return response(operation, {});
			attempts++;
			return attempts < 3
				? failedResponse(operation, "HANDSHAKE_REJECTED", "Managed PID is not registered yet")
				: response(operation, { handshake: "live", statusRevision: 4 });
		});
		const runtime = runtimeWith(transport, new FakeEvents(), {
			windowMs: 200,
			delayMs: 25,
			now: () => now,
			sleep: async (delayMs) => {
				sleeps.push(delayMs);
				now += delayMs;
			},
		});

		await expect(runtime.connect()).resolves.toEqual({
			lifecycleInstanceId: LIFE,
			protocolHandshakeLive: true,
		});
		expect(attempts).toBe(3);
		expect(sleeps).toEqual([25, 25]);
	});

	it("bounds handshake rejection retries and preserves the typed failure", async () => {
		let now = 0;
		const transport = new FakeTransport((operation) =>
			failedResponse(operation, "HANDSHAKE_REJECTED", "Managed PID is not registered yet"));
		const runtime = runtimeWith(transport, new FakeEvents(), {
			windowMs: 100,
			delayMs: 40,
			now: () => now,
			sleep: async (delayMs) => { now += delayMs; },
		});

		await expect(runtime.connect()).rejects.toMatchObject({
			operation: "lifecycleHandshake",
			result: { reasonCode: "HANDSHAKE_REJECTED" },
		});
		expect(transport.calls).toHaveLength(3);
		expect(now).toBe(80);
	});

	it("does not retry non-registration handshake failures", async () => {
		const sleep = vi.fn(async () => {});
		const transport = new FakeTransport((operation) =>
			failedResponse(operation, "AUTH_INVALID", "Bad token"));
		const runtime = runtimeWith(transport, new FakeEvents(), {
			windowMs: 200,
			delayMs: 25,
			now: () => 0,
			sleep,
		});

		await expect(runtime.connect()).rejects.toMatchObject({
			result: { reasonCode: "AUTH_INVALID" },
		});
		expect(transport.calls).toHaveLength(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("rereads after a readiness reconnect and submits the original mutation once", async () => {
		const events = new FakeEvents();
		let statusReads = 0;
		const transport = new FakeTransport((operation) => {
			if (operation === "lifecycleHandshake") {
				return response(operation, { handshake: "live", statusRevision: 1 });
			}
			if (operation === "getRuntimeStatus") {
				statusReads++;
				return response(
					operation,
					statusReads < 3
						? status("loading", false, statusReads)
						: status("ready", true, statusReads),
				);
			}
			return response(operation, { changed: true }, "op-original");
		});
		const runtime = runtimeWith(transport, events);

		const pending = runtime.invoke("setSliderValue", { targetId: "slider-1", value: 4 });
		await vi.waitFor(() => expect(statusReads).toBe(2));
		events.emitReconnect();
		await expect(pending).resolves.toMatchObject({ operationId: "op-original" });

		expect(transport.calls.filter((call) => call.operation === "setSliderValue")).toHaveLength(1);
		expect(transport.calls.filter((call) => call.operation === "getRuntimeStatus")).toHaveLength(3);
	});

	it("keeps an ambiguous mutation outcome Node-local", async () => {
		const snapshot = status("ready", true, 1);
		const unknown: NodeLocalOutcomeUnknown = {
			source: "node",
			lifecycleInstanceId: LIFE,
			requestId: "req-mutation",
			operation: "setSliderValue",
			operationId: "op-mutation",
			result: { class: "outcome_unknown", message: "reply lost" },
		};
		const transport = new FakeTransport((operation) => {
			if (operation === "lifecycleHandshake") {
				return response(operation, { handshake: "live", statusRevision: 1 });
			}
			if (operation === "getRuntimeStatus") return response(operation, snapshot);
			return unknown;
		});
		const runtime = runtimeWith(transport, new FakeEvents());

		try {
			await runtime.invoke("setSliderValue", { targetId: "slider-1", value: 4 });
			expect.fail("expected an unknown-outcome error");
		} catch (error) {
			expect(error).toBeInstanceOf(RpcOutcomeUnknownError);
			expect((error as RpcOutcomeUnknownError).outcome).toBe(unknown);
			expect((error as RpcOutcomeUnknownError).outcome.source).toBe("node");
			expect((error as Error).message).toContain("Mutation outcome is unknown");
			expect((error as Error).message).toContain("It may have completed");
			expect((error as Error).message).toContain("Do not retry automatically");
		}
	});

	it("notifies listeners before explicitly opening Grasshopper", async () => {
		let reads = 0;
		const order: string[] = [];
		const transport = new FakeTransport((operation) => {
			if (operation === "lifecycleHandshake") return response(operation, { handshake: "live" });
			if (operation === "getRuntimeStatus") {
				return response(operation, reads++ === 0 ? status("not_loaded", false, 1) : status("ready", true, 2));
			}
			if (operation === "startGrasshopper") order.push("start");
			return response(operation, {});
		});
		const runtime = runtimeWith(transport, new FakeEvents());
		runtime.subscribeNotices((notice) => {
			order.push("notice");
			expect(notice.message).toContain("create an untitled document");
		});

		await runtime.ensureGrasshopperReady();

		expect(order).toEqual(["notice", "start"]);
	});

	it("does not submit a Grasshopper operation without an active document", async () => {
		const snapshot = status("ready", false, 1);
		const transport = new FakeTransport((operation) => {
			if (operation === "lifecycleHandshake") {
				return response(operation, { handshake: "live", statusRevision: 1 });
			}
			return response(operation, snapshot);
		});
		const runtime = runtimeWith(transport, new FakeEvents());

		await expect(runtime.invoke(
			"getCurrentCanvas",
			{},
		)).rejects.toMatchObject({ reasonCode: "NO_ACTIVE_GRASSHOPPER_DOCUMENT" });
		expect(transport.calls.some((call) => call.operation === "getCurrentCanvas")).toBe(false);
	});

	it("keeps mutation-free and Rhino-only turns from starting Grasshopper", async () => {
		const snapshot = status("not_loaded", false, 1);
		const transport = new FakeTransport((operation) => response(
			operation,
			operation === "lifecycleHandshake"
				? { handshake: "live", statusRevision: 1 }
				: operation === "getRuntimeStatus"
					? snapshot
					: {},
		));
		const events = new FakeEvents();
		const runtime = runtimeWith(transport, events);

		runtime.beginAgentTurn();
		await runtime.invoke("queryRhinoObjects", {});
		await runtime.commitAgentTurn();
		runtime.beginAgentTurn();
		await runtime.invoke("runRhinoScript", { mode: "command", source: "_Line", echo: false });
		await runtime.commitAgentTurn();

		expect(events.subscribeCount).toBe(0);
		expect(transport.calls.some((call) => call.operation === "startGrasshopper")).toBe(false);
		expect(transport.calls.map((call) => call.operation)).toContain("beginRhinoAgentTransaction");
		expect(transport.calls.map((call) => call.operation)).toContain("commitRhinoAgentTransaction");
	});

	it("opens the Grasshopper transaction once on the first mutation", async () => {
		const snapshot = status("ready", true, 1);
		const transport = new FakeTransport((operation) => response(
			operation,
			operation === "lifecycleHandshake"
				? { handshake: "live", statusRevision: 1 }
				: operation === "getRuntimeStatus"
					? snapshot
					: {},
		));
		const runtime = runtimeWith(transport, new FakeEvents());

		runtime.beginAgentTurn();
		await runtime.invoke("setSliderValue", { targetId: "slider-1", value: 4 });
		await runtime.invoke("createPanel", { pivot: { x: 1, y: 2 } });
		await runtime.commitAgentTurn();

		const operations = transport.calls.map((call) => call.operation);
		expect(operations.filter((operation) => operation === "beginAgentTransaction")).toHaveLength(1);
		expect(operations.filter((operation) => operation === "commitAgentTransaction")).toHaveLength(1);
		expect(operations.indexOf("beginAgentTransaction")).toBeLessThan(operations.indexOf("setSliderValue"));
	});

	it("opens a GH document without an active canvas and never begins geometry Undo for a boundary", async () => {
		const transport = new FakeTransport((operation) => response(operation, operation === "getRuntimeStatus" ? status("ready", false, 1) : {}));
		const runtime = runtimeWith(transport, new FakeEvents());
		runtime.beginAgentTurn();
		await runtime.invoke("listGrasshopperDocuments", {});
		await runtime.invoke("manageGrasshopperDocument", { action: "open", path: "/a.gh", expectedActiveDocument: null, affectedDocuments: [] });
		expect(transport.calls.some((call) => call.operation === "beginAgentTransaction")).toBe(false);
		expect(transport.calls.filter((call) => call.operation === "manageGrasshopperDocument")).toHaveLength(1);
	});

	it("abandons stale local transaction ownership after a native document switch", async () => {
		let segment = { documentId: "doc-a", segmentId: "segment-a", epoch: 1, state: "active", lifecycleInstanceId: LIFE };
		const transport = new FakeTransport((operation) => response(operation,
			operation === "getDocumentTransactionState" ? segment : { transaction: segment }));
		const runtime = runtimeWith(transport, new FakeEvents());
		runtime.beginAgentTurn();
		await runtime.invoke("runRhinoScript", { mode: "python", source: "pass" });
		expect(transport.calls.find((call) => call.operation === "runRhinoScript")?.args).toMatchObject({ expectedSegment: { documentId: "doc-a", segmentId: "segment-a" } });
		segment = { ...segment, documentId: "doc-b", segmentId: "", state: "abandoned", epoch: 2 };
		await runtime.cancelAgentTurn();
		expect(transport.calls.some((call) => call.operation === "cancelRhinoAgentTransaction")).toBe(false);
	});

	it("blocks dependent edits and cancellation until an uncertain transition has a terminal result", async () => {
		let terminal = false;
		const segment = { documentId: "doc-b", segmentId: null, epoch: 2, state: "idle", lifecycleInstanceId: LIFE };
		const transport = new FakeTransport((operation) => {
			if (operation === "manageRhinoDocument") return {
				source: "node", protocolVersion: 2, lifecycleInstanceId: LIFE, requestId: "req-save", operation, operationId: "save-1",
				result: { class: "outcome_unknown", reasonCode: "COMPLETION_TIMEOUT", message: "Reply lost" },
			} as NodeLocalOutcomeUnknown;
			return response(operation, operation === "getOperationResult" ? { state: terminal ? "terminal" : "pending" }
				: operation === "getDocumentTransactionState" ? segment : {});
		});
		const runtime = runtimeWith(transport, new FakeEvents());
		runtime.beginAgentTurn();
		await expect(runtime.invoke("manageRhinoDocument", { action: "save", documentId: "doc-a", expectedStateToken: "v1" })).rejects.toBeInstanceOf(RpcOutcomeUnknownError);
		await expect(runtime.invoke("runRhinoScript", { mode: "python", source: "pass" })).rejects.toThrow("uncertain");
		await expect(runtime.cancelAgentTurn()).rejects.toThrow("uncertain");
		expect(transport.calls.some((call) => call.operation === "runRhinoScript" || call.operation === "cancelRhinoAgentTransaction")).toBe(false);
		terminal = true;
		await runtime.invoke("runRhinoScript", { mode: "python", source: "pass" });
		expect(transport.calls.filter((call) => call.operation === "manageRhinoDocument")).toHaveLength(1);
	});

	it("does not start Grasshopper when an unused turn is cancelled or closed", async () => {
		const transport = new FakeTransport((operation) => response(
			operation,
			operation === "lifecycleHandshake" ? { handshake: "live" } : {},
		));
		const events = new FakeEvents();
		const runtime = runtimeWith(transport, events);

		runtime.beginAgentTurn();
		await runtime.cancelAgentTurn();
		runtime.beginAgentTurn();
		await runtime.close();

		expect(events.subscribeCount).toBe(0);
		expect(transport.calls).toHaveLength(0);
	});
});

describe("Requester RPC v2 facade", () => {
	it("maps the existing domain request shape to an RPC operation and args", async () => {
		const request = vi.fn(async () => ({ type: "getCurrentCanvas.response" }));
		const requester = new Requester({ request } as unknown as RuntimeRpc);

		const result = await requester.request({
			type: "getCurrentCanvas",
			selectionOnly: true,
		});

		expect(request).toHaveBeenCalledWith("getCurrentCanvas", { selectionOnly: true });
		expect(result).toEqual({ type: "getCurrentCanvas.response" });
	});

	it("does not preserve the legacy ping operation as a fallback", async () => {
		const request = vi.fn();
		const requester = new Requester({ request } as unknown as RuntimeRpc);

		await expect(requester.request({ type: "ping" })).rejects.toThrow(
			"Unsupported RPC domain operation: ping",
		);
		expect(request).not.toHaveBeenCalled();
	});
});

function runtimeWith(
	transport: FakeTransport,
	events: FakeEvents,
	handshakeRetry?: ConstructorParameters<typeof RuntimeRpc>[0]["handshakeRetry"],
): RuntimeRpc {
	return new RuntimeRpc({
		lifecycleInstanceId: LIFE,
		transport,
		events,
		nodeProcessId: 42,
		nodeVersion: "v22.19.0",
		handshakeRetry,
	});
}

class FakeTransport implements RuntimeRpcTransport {
	readonly identity = "node-test-1";
	readonly calls: Array<{ operation: OperationName; args: unknown }> = [];

	constructor(private readonly handler: (operation: OperationName) => RpcCallResult) { }

	async connect(): Promise<void> { }
	async close(): Promise<void> { }

	async call<O extends OperationName>(
		operation: O,
		args: RequestArgsFor<O>,
		_options?: RpcCallOptions,
	): Promise<RpcCallResult> {
		this.calls.push({ operation, args });
		return this.handler(operation);
	}
}

class FakeEvents implements RuntimeStatusEventSource {
	private listener: (() => void) | null = null;
	subscribeCount = 0;

	async subscribe(onWakeup: () => void): Promise<() => void> {
		this.subscribeCount++;
		this.listener = onWakeup;
		return () => { this.listener = null; };
	}

	emitReconnect(): void {
		this.listener?.();
	}
}

function response(
	operation: OperationName,
	data: unknown,
	operationId?: string,
): RpcOperationResponse {
	return {
		protocolVersion: 2,
		lifecycleInstanceId: LIFE,
		requestId: `req-${operation}`,
		operation,
		...(operationId ? { operationId } : {}),
		result: { class: "completed", reasonCode: "OK", data: data as never },
	};
}

function failedResponse(
	operation: OperationName,
	reasonCode: "HANDSHAKE_REJECTED" | "AUTH_INVALID",
	message: string,
): RpcOperationResponse {
	return {
		protocolVersion: 2,
		lifecycleInstanceId: LIFE,
		requestId: `req-${operation}`,
		operation,
		result: { class: "failed", reasonCode, message },
	};
}

function status(
	grasshopperState: RuntimeStatus["grasshopper"]["state"],
	activeDocument: boolean,
	revision: number,
): RuntimeStatus {
	return {
		protocolVersion: 2,
		revision,
		observedAt: revision,
		lifecycle: { state: "running", changedAt: 1, reason: null },
		transport: { ready: true, lifecycleInstanceId: LIFE },
		host: {
			state: "running",
			processId: 42,
			nodePath: "/usr/local/bin/node",
			nodeVersion: "22.19.0",
			handshake: "live",
			healthFailureCount: 0,
		},
		rhino: { activeDocument: true, documentName: "model.3dm" },
		grasshopper: {
			state: grasshopperState,
			activeDocument,
			documentName: activeDocument ? "definition.gh" : null,
		},
		dispatcher: { acceptingExternalWork: true, depth: 0, capacity: 64 },
		errors: { transport: null, host: null, rhino: null, grasshopper: null, dispatcher: null },
	};
}
