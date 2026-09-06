import { clearDocumentGuidAliases } from "../services/guid-shortener.js";
import type { DocumentTransactionState } from "../types/document-management.js";
import {
	type RpcCallOptions,
	type RpcCallResult,
	HopperRpcClient,
	type NodeLocalOutcomeUnknown,
} from "./rpc-client.js";
import {
	classifyOperation,
	type JsonObject,
	type OperationName,
	type OperationResultSnapshot,
	type RequestArgsFor,
	type RpcOperationResponse,
	type RuntimeStatus,
} from "../protocol/v2.js";
import { resolveConnection } from "./connection.js";
import {
	GrasshopperReadinessCoordinator,
	type ReadinessClock,
	type RuntimeStatusEventSource,
} from "./grasshopper-readiness.js";
import { SubscriberStatusEventSource } from "./status-event-source.js";

export interface RuntimeRpcTransport {
	readonly identity: string;
	connect(): Promise<void>;
	call<O extends OperationName>(
		operation: O,
		args: RequestArgsFor<O>,
		options?: RpcCallOptions,
	): Promise<RpcCallResult>;
	close(): Promise<void>;
}

export type RuntimeRpcOptions = {
	lifecycleInstanceId: string;
	transport: RuntimeRpcTransport;
	events: RuntimeStatusEventSource;
	readinessClock?: ReadinessClock;
	readinessTimeoutMs?: number;
	nodeProcessId?: number;
	nodeVersion?: string;
	handshakeRetry?: Partial<HandshakeRetryPolicy>;
};

export type HandshakeRetryPolicy = {
	windowMs: number;
	delayMs: number;
	now: () => number;
	sleep: (delayMs: number) => Promise<void>;
};

export type LiveProtocolHandshake = {
	lifecycleInstanceId: string;
	protocolHandshakeLive: true;
};

export type RuntimeRpcNotice = {
	type: "grasshopper_starting";
	level: "warning";
	message: string;
	status: RuntimeStatus;
};

export class RpcOperationError extends Error {
	constructor(
		public readonly operation: OperationName,
		public readonly result: OperationResultSnapshot,
	) {
		super(result.message ?? `${operation} failed: ${result.reasonCode}`);
		this.name = "RpcOperationError";
	}
}

export class RpcOutcomeUnknownError extends Error {
	constructor(public readonly outcome: NodeLocalOutcomeUnknown) {
		super(
			`Mutation outcome is unknown for ${outcome.operation} ` +
			`(operation ID ${outcome.operationId}). It may have completed. ` +
			`Do not retry automatically; inspect Rhino or Grasshopper state first. ` +
			outcome.result.message,
		);
		this.name = "RpcOutcomeUnknownError";
	}
}

export class RuntimeRpc {
	private static readonly defaultHandshakeRetryWindowMs = 2_000;
	private static readonly defaultHandshakeRetryDelayMs = 50;

	readonly lifecycleInstanceId: string;

	private readonly transport: RuntimeRpcTransport;
	private readonly readiness: GrasshopperReadinessCoordinator;
	private readonly nodeProcessId: number;
	private readonly nodeVersion: string;
	private readonly handshakeRetry: HandshakeRetryPolicy;
	private handshake: Promise<void> | null = null;
	private handshakeComplete = false;
	private readonly noticeListeners = new Set<(notice: RuntimeRpcNotice) => void>();
	private turnAcceptingMutations = false;
	private turnId = 0;
	private readonly transactionOpen = { rhino: false, grasshopper: false };
	private readonly segments: Partial<Record<TransactionOwner, DocumentTransactionState>> = {};
	private readonly aliasDocuments: Partial<Record<TransactionOwner, string>> = {};
	private readonly mutationQueue: Partial<Record<TransactionOwner, Promise<unknown>>> = {};
	private readonly uncertainTransitions: Partial<Record<TransactionOwner, string>> = {};
	private readonly transactionOpening: Partial<Record<TransactionOwner, Promise<void>>> = {};

	constructor(options: RuntimeRpcOptions) {
		this.lifecycleInstanceId = options.lifecycleInstanceId;
		this.transport = options.transport;
		this.nodeProcessId = options.nodeProcessId ?? process.pid;
		this.nodeVersion = options.nodeVersion ?? process.version;
		this.handshakeRetry = {
			windowMs: options.handshakeRetry?.windowMs ?? RuntimeRpc.defaultHandshakeRetryWindowMs,
			delayMs: options.handshakeRetry?.delayMs ?? RuntimeRpc.defaultHandshakeRetryDelayMs,
			now: options.handshakeRetry?.now ?? Date.now,
			sleep: options.handshakeRetry?.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))),
		};
		if (!Number.isFinite(this.handshakeRetry.windowMs) || this.handshakeRetry.windowMs <= 0) {
			throw new Error("handshake retry window must be positive");
		}
		if (!Number.isFinite(this.handshakeRetry.delayMs) || this.handshakeRetry.delayMs <= 0) {
			throw new Error("handshake retry delay must be positive");
		}
		this.readiness = new GrasshopperReadinessCoordinator({
			lifecycleInstanceId: options.lifecycleInstanceId,
			events: options.events,
			clock: options.readinessClock,
			timeoutMs: options.readinessTimeoutMs,
			readStatus: (timeoutMs) => this.readRuntimeStatusDirect(timeoutMs),
			startGrasshopper: (timeoutMs) => this.startGrasshopperDirect(timeoutMs),
			beforeStartGrasshopper: (status) => this.publishNotice({
				type: "grasshopper_starting",
				level: "warning",
				message: "Grasshopper is opening. Rhino may show the Grasshopper editor and create an untitled document.",
				status,
			}),
		});
	}

	subscribeNotices(listener: (notice: RuntimeRpcNotice) => void): () => void {
		this.noticeListeners.add(listener);
		return () => this.noticeListeners.delete(listener);
	}

	async connect(): Promise<LiveProtocolHandshake> {
		await this.ensureHandshake();
		return {
			lifecycleInstanceId: this.lifecycleInstanceId,
			protocolHandshakeLive: true,
		};
	}

	async invoke<O extends OperationName>(
		operation: O,
		args: RequestArgsFor<O>,
		options: RpcCallOptions = {},
	): Promise<RpcOperationResponse<O>> {
		await this.ensureHandshake();
		const owner: RpcOperationOwner = RPC_OPERATION_OWNERS[operation];
		if (owner === "core" || classifyOperation(operation) !== "mutation") return this.invokeOwned(operation, args, options);
		const previous = this.mutationQueue[owner];
		const pending = (async () => {
			if (previous) await previous.catch(() => {});
			return this.invokeOwned(operation, args, options);
		})();
		this.mutationQueue[owner] = pending;
		try { return await pending; }
		finally { if (this.mutationQueue[owner] === pending) delete this.mutationQueue[owner]; }
	}

	private async invokeOwned<O extends OperationName>(operation: O, args: RequestArgsFor<O>, options: RpcCallOptions): Promise<RpcOperationResponse<O>> {
		if (requiresGrasshopper(operation)) await this.readiness.ensureReady(operation !== "manageGrasshopperDocument");
		const owner: RpcOperationOwner = RPC_OPERATION_OWNERS[operation];
		const boundary = DOCUMENT_BOUNDARIES.has(operation);
		if (owner !== "core" && classifyOperation(operation) === "mutation" && !TRANSACTION_OPERATIONS.has(operation)) {
			await this.reconcileTransaction(owner);
		}
		await this.ensureTransactionForMutation(operation);
		const segment = owner === "core" ? undefined : this.segments[owner];
		const callArgs = !boundary && segment?.state === "active" && classifyOperation(operation) === "mutation"
			? { ...args, expectedSegment: segment } as RequestArgsFor<O> : args;
		try {
			const response = await this.invokeDirect(operation, callArgs, options);
			if (owner !== "core") this.observeTransaction(owner, response.result.data);
			return response;
		} catch (error) {
			if (owner !== "core" && error instanceof RpcOutcomeUnknownError) this.uncertainTransitions[owner] = error.outcome.operationId;
			throw error;
		} finally {
			if (boundary && owner !== "core") {
				this.transactionOpen[owner] = false;
				clearDocumentGuidAliases(owner);
			}
		}
	}

	async request<T>(operation: OperationName, args: JsonObject): Promise<T> {
		const response = await this.invoke(
			operation,
			args as RequestArgsFor<typeof operation>,
		);
		return response.result.data as T;
	}

	async getRuntimeStatus(completionTimeoutMs?: number): Promise<RuntimeStatus> {
		await this.ensureHandshake(completionTimeoutMs);
		return this.readRuntimeStatusDirect(completionTimeoutMs);
	}

	async ensureGrasshopperReady(): Promise<RuntimeStatus> {
		await this.ensureHandshake();
		return this.readiness.ensureReady();
	}

	beginAgentTurn(): void {
		if (this.turnAcceptingMutations
			|| this.transactionOpen.rhino
			|| this.transactionOpen.grasshopper
			|| this.transactionOpening.rhino
			|| this.transactionOpening.grasshopper) return;
		this.turnId++;
		this.turnAcceptingMutations = true;
	}

	async commitAgentTurn(): Promise<void> {
		await this.finishAgentTurn("commit");
	}

	async cancelAgentTurn(): Promise<void> {
		await this.finishAgentTurn("cancel");
	}

	async close(): Promise<void> {
		this.noticeListeners.clear();
		this.readiness.close();
		await this.cancelAgentTurn();
		await this.transport.close();
	}

	private publishNotice(notice: RuntimeRpcNotice): void {
		for (const listener of this.noticeListeners) listener(notice);
	}

	private async ensureHandshake(completionTimeoutMs?: number): Promise<void> {
		if (this.handshakeComplete) return;
		if (this.handshake) return this.handshake;

		const pending = (async () => {
			await this.transport.connect();
			await this.completeInitialHandshake(completionTimeoutMs);
			this.handshakeComplete = true;
		})();
		this.handshake = pending;
		try {
			await pending;
		} finally {
			if (this.handshake === pending) this.handshake = null;
		}
	}

	private async completeInitialHandshake(completionTimeoutMs?: number): Promise<void> {
		const windowMs = completionTimeoutMs
			? Math.min(completionTimeoutMs, this.handshakeRetry.windowMs)
			: this.handshakeRetry.windowMs;
		const deadlineAt = this.handshakeRetry.now() + windowMs;
		let lastRejection: RpcOperationError | null = null;

		while (this.handshakeRetry.now() < deadlineAt) {
			const remainingMs = Math.max(1, deadlineAt - this.handshakeRetry.now());
			try {
				await this.invokeDirect(
					"lifecycleHandshake",
					{
						nodeProcessId: this.nodeProcessId,
						nodeVersion: this.nodeVersion,
						clientIdentity: this.transport.identity,
					},
					{
						completionTimeoutMs: remainingMs,
						startDeadlineMs: Math.min(30_000, remainingMs),
					},
				);
				return;
			} catch (error) {
				if (!(error instanceof RpcOperationError)
					|| error.operation !== "lifecycleHandshake"
					|| error.result.reasonCode !== "HANDSHAKE_REJECTED") {
					throw error;
				}
				lastRejection = error;
			}

			const retryRemainingMs = deadlineAt - this.handshakeRetry.now();
			if (retryRemainingMs < this.handshakeRetry.delayMs) break;
			await this.handshakeRetry.sleep(this.handshakeRetry.delayMs);
		}

		throw lastRejection ?? new Error("RPC handshake retry window expired");
	}

	private async readRuntimeStatusDirect(completionTimeoutMs?: number): Promise<RuntimeStatus> {
		const response = await this.invokeDirect("getRuntimeStatus", {}, completionTimeoutMs
			? {
				completionTimeoutMs,
				startDeadlineMs: Math.min(30_000, completionTimeoutMs),
			}
			: {});
		return response.result.data as RuntimeStatus;
	}

	private async startGrasshopperDirect(completionTimeoutMs: number): Promise<void> {
		await this.invokeDirect("startGrasshopper", {}, {
			completionTimeoutMs,
			startDeadlineMs: Math.min(30_000, completionTimeoutMs),
		});
	}

	private async ensureTransactionForMutation(operation: OperationName): Promise<void> {
		if (!this.turnAcceptingMutations
			|| classifyOperation(operation) !== "mutation"
			|| TRANSACTION_OPERATIONS.has(operation)
			|| DOCUMENT_BOUNDARIES.has(operation)) return;
		const owner: RpcOperationOwner = RPC_OPERATION_OWNERS[operation];
		if (owner !== "rhino" && owner !== "grasshopper") return;
		if (this.transactionOpen[owner]) return;
		if (this.transactionOpening[owner]) return this.transactionOpening[owner];

		const currentTurn = this.turnId;
		const transactionOperation: TransactionOperation = owner === "rhino"
			? "beginRhinoAgentTransaction"
			: "beginAgentTransaction";
		const pending = (async () => {
			const started = await this.runTransactionControl(
				transactionOperation,
				{ name: "Hopper agent" },
			);
			if (started && currentTurn === this.turnId)
				this.transactionOpen[owner] = true;
		})();
		this.transactionOpening[owner] = pending;
		try {
			await pending;
		} finally {
			if (this.transactionOpening[owner] === pending)
				delete this.transactionOpening[owner];
		}
	}

	private async finishAgentTurn(outcome: "commit" | "cancel"): Promise<void> {
		this.turnAcceptingMutations = false;
		await Promise.allSettled(Object.values(this.mutationQueue));
		await Promise.all(Object.values(this.transactionOpening));
		await this.reconcileTransaction("grasshopper");
		await this.reconcileTransaction("rhino");
		const grasshopperOpen = this.transactionOpen.grasshopper;
		const rhinoOpen = this.transactionOpen.rhino;
		this.transactionOpen.grasshopper = false;
		this.transactionOpen.rhino = false;

		if (grasshopperOpen) {
			await this.runTransactionControl(
				outcome === "commit" ? "commitAgentTransaction" : "cancelAgentTransaction",
				{},
			);
		}
		if (rhinoOpen) {
			await this.runTransactionControl(
				outcome === "commit"
					? "commitRhinoAgentTransaction"
					: "cancelRhinoAgentTransaction",
				{},
			);
		}
	}

	private observeTransaction(owner: TransactionOwner, data: unknown): void {
		const candidate = data && typeof data === "object" && "transaction" in data ? data.transaction : undefined;
		if (candidate && typeof candidate === "object" && "segmentId" in candidate && "epoch" in candidate) {
			const segment = candidate as DocumentTransactionState;
			if (segment.lifecycleInstanceId !== this.lifecycleInstanceId) throw new Error("Transaction belongs to a stale host lifecycle.");
			// Idle segments have no document identity. Ending an undo record does not
			// invalidate the aliases read from the same open document.
			if (segment.documentId) this.observeAliasDocument(owner, segment.documentId);
			this.segments[owner] = segment;
			this.transactionOpen[owner] = segment.state === "active";
		}
		if (data && typeof data === "object" && "activeDocumentId" in data) {
			if (typeof data.activeDocumentId === "string") this.observeAliasDocument(owner, data.activeDocumentId);
			else if (data.activeDocumentId === null) {
				clearDocumentGuidAliases(owner);
				delete this.aliasDocuments[owner];
			}
		}
	}

	private observeAliasDocument(owner: TransactionOwner, documentId: string): void {
		const previous = this.aliasDocuments[owner];
		if (previous !== undefined && previous !== documentId) clearDocumentGuidAliases(owner);
		this.aliasDocuments[owner] = documentId;
	}

	private async reconcileTransaction(owner: TransactionOwner): Promise<void> {
		const operationId = this.uncertainTransitions[owner];
		if (operationId) {
			const result = await this.invokeDirect("getOperationResult", { operationId });
			const data = result.result.data;
			if (!data || typeof data !== "object" || !("state" in data) || data.state !== "terminal")
				throw new Error(`Operation ${operationId} remains uncertain. Dependent edits and cancellation are blocked.`);
		}
		if (operationId || this.segments[owner]) {
			const response = await this.invokeDirect("getDocumentTransactionState", { owner });
			const data = response.result.data;
			if (!data || typeof data !== "object" || !("segmentId" in data)) throw new Error("Transaction reconciliation returned no segment state.");
			this.observeTransaction(owner, { transaction: data });
			delete this.uncertainTransitions[owner];
		}
	}

	private async runTransactionControl(operation: TransactionOperation, args: JsonObject): Promise<boolean> {
		const owner = RPC_OPERATION_OWNERS[operation] as TransactionOwner;
		if (!operation.startsWith("begin")) await this.reconcileTransaction(owner);
		const segment = this.segments[owner];
		if (!operation.startsWith("begin") && segment && segment.state !== "active") return true;
		try {
			const response = await this.invokeDirect(operation, segment?.state === "active" ? { ...args, expectedSegment: segment } : args);
			this.observeTransaction(owner, response.result.data);
			const data = response.result.data;
			if (data && typeof data === "object" && "ok" in data && data.ok === false) throw new Error(`Transaction control ${operation} failed: ${JSON.stringify(data)}`);
			return true;
		} catch (error) {
			if (error instanceof RpcOutcomeUnknownError) this.uncertainTransitions[owner] = error.outcome.operationId;
			throw error;
		}
	}

	private async invokeDirect<O extends OperationName>(
		operation: O,
		args: RequestArgsFor<O>,
		options: RpcCallOptions = {},
	): Promise<RpcOperationResponse<O>> {
		const response = await this.transport.call(operation, args, options);
		if ("source" in response) throw new RpcOutcomeUnknownError(response);
		if (response.result.class !== "completed") {
			throw new RpcOperationError(operation, response.result);
		}
		return response as RpcOperationResponse<O>;
	}
}

export type RpcOperationOwner = "core" | "rhino" | "grasshopper";
type TransactionOwner = Exclude<RpcOperationOwner, "core">;
type TransactionOperation =
	| "beginAgentTransaction"
	| "commitAgentTransaction"
	| "cancelAgentTransaction"
	| "beginRhinoAgentTransaction"
	| "commitRhinoAgentTransaction"
	| "cancelRhinoAgentTransaction";
const TRANSACTION_OPERATIONS = new Set<OperationName>([
	"beginAgentTransaction",
	"commitAgentTransaction",
	"cancelAgentTransaction",
	"beginRhinoAgentTransaction",
	"commitRhinoAgentTransaction",
	"cancelRhinoAgentTransaction",
]);

const DOCUMENT_BOUNDARIES = new Set<OperationName>(["manageRhinoDocument", "manageGrasshopperDocument"]);
const PASSIVE_DOCUMENT_READS = new Set<OperationName>(["listGrasshopperDocuments", "getGrasshopperDocument", "getGrasshopperDocumentSettings"]);

export const RPC_OPERATION_OWNERS = Object.freeze({
	browseDocumentFiles: "core",
	getDocumentTransactionState: "core",
	listRhinoDocuments: "rhino",
	getRhinoDocument: "rhino",
	getRhinoDocumentSettings: "rhino",
	manageRhinoDocument: "rhino",
	listGrasshopperDocuments: "grasshopper",
	getGrasshopperDocument: "grasshopper",
	getGrasshopperDocumentSettings: "grasshopper",
	manageGrasshopperDocument: "grasshopper",
	getRuntimeStatus: "core",
	getOperationResult: "core",
	lifecycleHandshake: "core",
	startGrasshopper: "core",
	cancelOperation: "core",
	queryRhinoObjects: "rhino",
	captureRhinoView: "rhino",
	runRhinoScript: "rhino",
	controlRhinoView: "rhino",
	beginRhinoAgentTransaction: "rhino",
	commitRhinoAgentTransaction: "rhino",
	cancelRhinoAgentTransaction: "rhino",
	listAllComponents: "grasshopper",
	getCurrentCanvas: "grasshopper",
	getCanvasErrors: "grasshopper",
	listScriptParams: "grasshopper",
	getScriptCode: "grasshopper",
	getParamRhinoGeometry: "grasshopper",
	applyGraph: "grasshopper",
	addComponent: "grasshopper",
	deleteComponent: "grasshopper",
	connectWire: "grasshopper",
	disconnectWire: "grasshopper",
	moveComponent: "grasshopper",
	renameComponent: "grasshopper",
	setComponentLocked: "grasshopper",
	setComponentHidden: "grasshopper",
	addGroup: "grasshopper",
	removeFromGroup: "grasshopper",
	deleteGroup: "grasshopper",
	changeGroupColor: "grasshopper",
	renameGroup: "grasshopper",
	changeGroupStyle: "grasshopper",
	createSlider: "grasshopper",
	editSliderRange: "grasshopper",
	setSliderValue: "grasshopper",
	createPanel: "grasshopper",
	setPanelParams: "grasshopper",
	setPanelText: "grasshopper",
	createToggle: "grasshopper",
	setToggleValue: "grasshopper",
	createSwatch: "grasshopper",
	setSwatchColor: "grasshopper",
	createScribble: "grasshopper",
	setScribbleText: "grasshopper",
	createValueList: "grasshopper",
	setValueListSelected: "grasshopper",
	createScriptNode: "grasshopper",
	setScriptCode: "grasshopper",
	syncScriptParams: "grasshopper",
	addScriptInput: "grasshopper",
	removeScriptInput: "grasshopper",
	addScriptOutput: "grasshopper",
	removeScriptOutput: "grasshopper",
	editParamProps: "grasshopper",
	beginAgentTransaction: "grasshopper",
	commitAgentTransaction: "grasshopper",
	cancelAgentTransaction: "grasshopper",
	setParamRhinoGeometry: "grasshopper",
} as const satisfies Record<OperationName, RpcOperationOwner>);

export function requiresGrasshopper(operation: OperationName): boolean {
	return RPC_OPERATION_OWNERS[operation] === "grasshopper" && !PASSIVE_DOCUMENT_READS.has(operation);
}

let sharedRuntime: RuntimeRpc | null = null;
let sharedAgentTurnActive = false;

export function beginRuntimeAgentTurn(): void {
	sharedAgentTurnActive = true;
	sharedRuntime?.beginAgentTurn();
}

export async function commitRuntimeAgentTurn(): Promise<void> {
	sharedAgentTurnActive = false;
	await sharedRuntime?.commitAgentTurn();
}

export async function cancelRuntimeAgentTurn(): Promise<void> {
	sharedAgentTurnActive = false;
	await sharedRuntime?.cancelAgentTurn();
}

export function getRuntimeRpc(): RuntimeRpc {
	if (sharedRuntime) return sharedRuntime;
	const connection = resolveConnection();
	const transport = new HopperRpcClient({
		endpoint: connection.rpcEndpoint,
		lifecycleInstanceId: connection.lifecycleInstanceId,
		token: connection.token,
	});
	sharedRuntime = new RuntimeRpc({
		lifecycleInstanceId: connection.lifecycleInstanceId,
		transport,
		events: new SubscriberStatusEventSource(connection.pubEndpoint),
	});
	if (sharedAgentTurnActive) sharedRuntime.beginAgentTurn();
	return sharedRuntime;
}

export async function resetRuntimeRpcForTests(): Promise<void> {
	await closeRuntimeRpc();
}

export async function closeRuntimeRpc(): Promise<void> {
	const runtime = sharedRuntime;
	sharedRuntime = null;
	sharedAgentTurnActive = false;
	if (runtime) await runtime.close();
}
