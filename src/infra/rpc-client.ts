import { randomUUID } from "node:crypto";
import {
	PROTOCOL_VERSION,
	type HopperRpcRequest,
	type HopperRpcResponse,
	type MutationOperation,
	type OperationName,
	type OperationResultSnapshot,
	type RequestArgsFor,
	type RpcOperationResponse,
	classifyOperation,
	validateRpcRequest,
	validateRpcResponse,
} from "../protocol/v2.js";

export interface DealerSocket {
	connect(endpoint: string): void | Promise<void>;
	send(payload: Uint8Array): void | Promise<void>;
	receive(): Promise<readonly Uint8Array[]>;
	close(): void | Promise<void>;
}

export interface DealerSocketFactory {
	create(identity: string): DealerSocket | Promise<DealerSocket>;
}

export interface RpcClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

const systemClock: RpcClock = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class RpcDisconnectedError extends Error {
	constructor(message = "Hopper RPC transport disconnected") {
		super(message);
		this.name = "RpcDisconnectedError";
	}
}

export class RpcTimeoutError extends Error {
	constructor(
		public readonly requestId: string,
		public readonly operation: OperationName,
	) {
		super(`Hopper RPC ${operation} timed out`);
		this.name = "RpcTimeoutError";
	}
}

export class RpcProtocolError extends Error {
	constructor(
		public readonly reasonCode: string,
		public readonly requestId: string,
		message: string,
	) {
		super(message);
		this.name = "RpcProtocolError";
	}
}

export class RpcResponseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcResponseError";
	}
}

export type NodeLocalOutcomeUnknown = {
	source: "node";
	lifecycleInstanceId: string;
	requestId: string;
	operation: MutationOperation;
	operationId: string;
	result: {
		class: "outcome_unknown";
		message: string;
	};
};

export type RpcCallResult = RpcOperationResponse | NodeLocalOutcomeUnknown;

export type RpcCallOptions = {
	/** Checked before transport send; never claims to interrupt native execution. */
	signal?: AbortSignal;
	startDeadlineMs?: number;
	completionTimeoutMs?: number;
	operationId?: string;
};

export type RpcClientOptions = {
	endpoint: string;
	lifecycleInstanceId: string;
	token: string;
	socketFactory?: DealerSocketFactory;
	clock?: RpcClock;
	identity?: string;
	requestIdFactory?: () => string;
	operationIdFactory?: () => string;
	defaultStartDeadlineMs?: number;
	defaultCompletionTimeoutMs?: number;
	recoveryPollMs?: number;
	recoveryRequestTimeoutMs?: number;
	sleep?: (delayMs: number) => Promise<void>;
};

type PendingRequest = {
	request: HopperRpcRequest;
	deadlineAt: number;
	sent: boolean;
	recovering: boolean;
	timer: unknown;
	resolve: (response: RpcCallResult) => void;
	reject: (error: Error) => void;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class ZeroMqDealerSocketFactory implements DealerSocketFactory {
	async create(identity: string): Promise<DealerSocket> {
		const { Dealer } = await import("zeromq");
		const socket = new Dealer({ routingId: identity });
		return {
			connect: (endpoint) => socket.connect(endpoint),
			send: (payload) => socket.send(payload),
			receive: () => socket.receive(),
			close: () => socket.close(),
		};
	}
}

function defaultSleep(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function makeIdentifier(prefix: string): string {
	return `${prefix}-${randomUUID()}`;
}

function isIdentifier(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function isProtocolError(response: HopperRpcResponse): response is Extract<HopperRpcResponse, { errorType: "protocol_error" }> {
	return "errorType" in response;
}

export class HopperRpcClient {
	readonly identity: string;

	private readonly endpoint: string;
	private readonly lifecycleInstanceId: string;
	private readonly token: string;
	private readonly socketFactory: DealerSocketFactory;
	private readonly clock: RpcClock;
	private readonly requestIdFactory: () => string;
	private readonly operationIdFactory: () => string;
	private readonly defaultStartDeadlineMs: number;
	private readonly defaultCompletionTimeoutMs: number;
	private readonly recoveryPollMs: number;
	private readonly recoveryRequestTimeoutMs: number;
	private readonly sleep: (delayMs: number) => Promise<void>;
	private readonly pending = new Map<string, PendingRequest>();
	private socket: DealerSocket | null = null;
	private connectPromise: Promise<DealerSocket> | null = null;
	private closed = false;

	constructor(options: RpcClientOptions) {
		if (!options.endpoint) throw new Error("RPC endpoint is required");
		if (!isIdentifier(options.lifecycleInstanceId)) throw new Error("lifecycleInstanceId is invalid");
		if (!/^[A-Za-z0-9_-]{32,128}$/.test(options.token)) throw new Error("RPC token is invalid");
		this.endpoint = options.endpoint;
		this.lifecycleInstanceId = options.lifecycleInstanceId;
		this.token = options.token;
		this.socketFactory = options.socketFactory ?? new ZeroMqDealerSocketFactory();
		this.clock = options.clock ?? systemClock;
		this.identity = options.identity ?? `hopper-node-${process.pid}-${randomUUID()}`;
		if (!isIdentifier(this.identity)) throw new Error("DEALER identity is invalid");
		this.requestIdFactory = options.requestIdFactory ?? (() => makeIdentifier("req"));
		this.operationIdFactory = options.operationIdFactory ?? (() => makeIdentifier("op"));
		this.defaultStartDeadlineMs = options.defaultStartDeadlineMs ?? 30_000;
		this.defaultCompletionTimeoutMs = options.defaultCompletionTimeoutMs ?? 120_000;
		this.recoveryPollMs = options.recoveryPollMs ?? 250;
		this.recoveryRequestTimeoutMs = options.recoveryRequestTimeoutMs ?? 5_000;
		this.sleep = options.sleep ?? defaultSleep;
	}

	get pendingCount(): number {
		return this.pending.size;
	}

	async connect(): Promise<void> {
		await this.ensureConnected();
	}

	async call<O extends OperationName>(
		operation: O,
		args: RequestArgsFor<O>,
		options: RpcCallOptions = {},
	): Promise<RpcCallResult> {
		if (this.closed) throw new RpcDisconnectedError("Hopper RPC client is closed");
		const operationClass = classifyOperation(operation);
		if (!operationClass) throw new Error(`Unknown RPC operation: ${operation}`);
		if (operationClass !== "mutation" && options.operationId !== undefined) {
			throw new Error("operationId is only valid for mutation calls");
		}

		const requestId = this.requestIdFactory();
		const now = this.clock.now();
		const startDeadlineMs = options.startDeadlineMs ?? this.defaultStartDeadlineMs;
		const completionTimeoutMs = options.completionTimeoutMs ?? this.defaultCompletionTimeoutMs;
		if (!Number.isFinite(startDeadlineMs) || startDeadlineMs < 0) throw new Error("startDeadlineMs is invalid");
		if (!Number.isFinite(completionTimeoutMs) || completionTimeoutMs <= 0) throw new Error("completionTimeoutMs is invalid");

		const base = {
			protocolVersion: PROTOCOL_VERSION,
			lifecycleInstanceId: this.lifecycleInstanceId,
			requestId,
			token: this.token,
			operation,
			startDeadlineAt: now + startDeadlineMs,
			args,
		};
		const request = operationClass === "mutation"
			? { ...base, operationId: options.operationId ?? this.operationIdFactory() }
			: base;
		const validation = validateRpcRequest(request);
		if (!validation.ok) throw new Error(`Invalid RPC request: ${validation.errors.join("; ")}`);

		const result = new Promise<RpcCallResult>((resolve, reject) => {
			const pending: PendingRequest = {
				request: validation.value,
				deadlineAt: now + completionTimeoutMs,
				sent: false,
				recovering: false,
				timer: undefined,
				resolve,
				reject,
			};
			pending.timer = this.clock.setTimeout(
				() => this.onCompletionTimeout(pending),
				completionTimeoutMs,
			);
			this.pending.set(requestId, pending);
		});

		let socket: DealerSocket | null = null;
		try {
			socket = await this.ensureConnected();
			const pending = this.pending.get(requestId);
			if (!pending) return result;
			if (options.signal?.aborted) {
				this.resolvePending(pending, {
					protocolVersion: PROTOCOL_VERSION, lifecycleInstanceId: this.lifecycleInstanceId,
					requestId, operation,
					...(operationClass === "mutation" ? { operationId: (request as { operationId: string }).operationId } : {}),
					result: {
						class: "cancelled_before_start", reasonCode: "CANCELLED_BEFORE_START",
						message: "Tool call cancelled before transport dispatch",
					},
				});
				return result;
			}
			// Once send begins, delivery is ambiguous if the socket disconnects. Mark it
			// before awaiting ZeroMQ so a receive-side failure cannot race this flag.
			pending.sent = true;
			await socket.send(encoder.encode(JSON.stringify(validation.value)));
		} catch (error) {
			const pending = this.pending.get(requestId);
			if (socket && pending?.sent) {
				await this.handleDisconnect(socket, asError(error));
			} else if (pending) {
				this.rejectPending(pending, asError(error));
			}
		}
		return result;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const socket = this.socket;
		this.socket = null;
		this.connectPromise = null;
		if (socket) {
			try { await socket.close(); } catch { }
		}
		for (const pending of [...this.pending.values()]) {
			if (classifyOperation(pending.request.operation) === "mutation" && pending.sent) {
				this.resolveUnknown(pending, "RPC client closed after the mutation was sent.");
			} else {
				this.rejectPending(pending, new RpcDisconnectedError("Hopper RPC client closed"));
			}
		}
	}

	private async ensureConnected(): Promise<DealerSocket> {
		if (this.closed) throw new RpcDisconnectedError("Hopper RPC client is closed");
		if (this.socket) return this.socket;
		if (this.connectPromise) return this.connectPromise;
		this.connectPromise = (async () => {
			const socket = await this.socketFactory.create(this.identity);
			try {
				await socket.connect(this.endpoint);
			} catch (error) {
				try { await socket.close(); } catch { }
				throw error;
			}
			if (this.closed) {
				try { await socket.close(); } catch { }
				throw new RpcDisconnectedError("Hopper RPC client is closed");
			}
			this.socket = socket;
			void this.receiveLoop(socket);
			return socket;
		})();
		try {
			return await this.connectPromise;
		} finally {
			this.connectPromise = null;
		}
	}

	private async receiveLoop(socket: DealerSocket): Promise<void> {
		try {
			while (!this.closed && this.socket === socket) {
				const frames = await socket.receive();
				if (frames.length !== 1) continue;
				this.handlePayload(decoder.decode(frames[0]));
			}
		} catch (error) {
			if (!this.closed && this.socket === socket) await this.handleDisconnect(socket, asError(error));
		}
	}

	private handlePayload(payload: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			return;
		}
		const validation = validateRpcResponse(parsed);
		if (!validation.ok) return;
		const response = validation.value;
		const pending = this.pending.get(response.requestId);
		if (!pending) return;
		if (isProtocolError(response)) {
			this.rejectPending(pending, new RpcProtocolError(
				response.result.reasonCode,
				response.requestId,
				response.result.message,
			));
			return;
		}
		if (response.lifecycleInstanceId !== this.lifecycleInstanceId
			|| response.operation !== pending.request.operation
			|| ("operationId" in pending.request && response.operationId !== pending.request.operationId)) {
			this.rejectPending(pending, new RpcResponseError("RPC response does not match its request"));
			return;
		}
		this.resolvePending(pending, response);
	}

	private async handleDisconnect(socket: DealerSocket, cause: Error): Promise<void> {
		if (this.socket !== socket) return;
		this.socket = null;
		try { await socket.close(); } catch { }
		for (const pending of [...this.pending.values()]) {
			if (classifyOperation(pending.request.operation) === "mutation" && pending.sent) {
				this.startMutationRecovery(pending);
			} else {
				this.rejectPending(pending, new RpcDisconnectedError(cause.message));
			}
		}
	}

	private startMutationRecovery(pending: PendingRequest): void {
		if (pending.recovering || !("operationId" in pending.request)) return;
		pending.recovering = true;
		void this.recoverMutation(pending);
	}

	private async recoverMutation(pending: PendingRequest): Promise<void> {
		const operationId = "operationId" in pending.request ? pending.request.operationId : null;
		if (!operationId) return;
		while (!this.closed && this.pending.get(pending.request.requestId) === pending) {
			const remaining = pending.deadlineAt - this.clock.now();
			if (remaining <= 0) return;
			try {
				const lookup = await this.call("getOperationResult", { operationId }, {
					startDeadlineMs: Math.min(this.defaultStartDeadlineMs, remaining),
					completionTimeoutMs: Math.max(1, Math.min(this.recoveryRequestTimeoutMs, remaining)),
				});
				if ("source" in lookup) continue;
				const data = lookup.result.class === "completed" ? lookup.result.data : undefined;
				if (isOperationLookupData(data) && data.state === "terminal") {
					this.resolvePending(pending, {
						protocolVersion: PROTOCOL_VERSION,
						lifecycleInstanceId: this.lifecycleInstanceId,
						requestId: pending.request.requestId,
						operation: pending.request.operation,
						operationId,
						result: data.result,
					});
					return;
				}
			} catch {
				// A lookup may lose its own connection. The original mutation is still not resubmitted.
			}
			if (this.pending.get(pending.request.requestId) !== pending) return;
			await this.sleep(Math.min(this.recoveryPollMs, Math.max(0, pending.deadlineAt - this.clock.now())));
		}
	}

	private onCompletionTimeout(pending: PendingRequest): void {
		if (this.pending.get(pending.request.requestId) !== pending) return;
		if (classifyOperation(pending.request.operation) === "mutation" && pending.sent) {
			this.resolveUnknown(pending, "The completion budget ended after the mutation was sent. Its outcome is unknown.");
		} else {
			this.rejectPending(pending, new RpcTimeoutError(pending.request.requestId, pending.request.operation));
		}
	}

	private resolveUnknown(pending: PendingRequest, message: string): void {
		if (!("operationId" in pending.request)) {
			this.rejectPending(pending, new RpcResponseError("Mutation request has no operationId"));
			return;
		}
		this.finishPending(pending);
		pending.resolve({
			source: "node",
			lifecycleInstanceId: this.lifecycleInstanceId,
			requestId: pending.request.requestId,
			operation: pending.request.operation as MutationOperation,
			operationId: pending.request.operationId,
			result: { class: "outcome_unknown", message },
		});
	}

	private resolvePending(pending: PendingRequest, response: RpcOperationResponse): void {
		this.finishPending(pending);
		pending.resolve(response);
	}

	private rejectPending(pending: PendingRequest, error: Error): void {
		this.finishPending(pending);
		pending.reject(error);
	}

	private finishPending(pending: PendingRequest): void {
		if (this.pending.get(pending.request.requestId) !== pending) return;
		this.pending.delete(pending.request.requestId);
		this.clock.clearTimeout(pending.timer);
	}
}

type OperationLookupData =
	| { state: "pending"; phase: "queued" | "running" }
	| { state: "not_found" }
	| { state: "terminal"; result: OperationResultSnapshot };

function isOperationLookupData(data: unknown): data is OperationLookupData {
	if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
	return "state" in data && ["pending", "not_found", "terminal"].includes(String(data.state));
}
