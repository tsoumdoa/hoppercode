import type { DocumentRequest } from "../types/document-management.js";
export const PROTOCOL_VERSION = 2 as const;

export const QUERY_OPERATIONS = [
	"listRhinoDocuments",
	"getRhinoDocument",
	"getRhinoDocumentSettings",
	"listGrasshopperDocuments",
	"getGrasshopperDocument",
	"getGrasshopperDocumentSettings",
	"browseDocumentFiles",
	"getDocumentTransactionState",

	"getRuntimeStatus",
	"getOperationResult",
	"listAllComponents",
	"getCurrentCanvas",
	"getCanvasErrors",
	"listScriptParams",
	"getScriptCode",
	"queryRhinoObjects",
	"captureRhinoView",
	"getParamRhinoGeometry",
] as const;

export const CONTROL_OPERATIONS = [
	"lifecycleHandshake",
	"startGrasshopper",
	"cancelOperation",
] as const;

export const MUTATION_OPERATIONS = [
	"manageRhinoDocument",
	"manageGrasshopperDocument",

	"applyGraph",
	"runRhinoScript",
	"controlRhinoView",
	"addComponent",
	"deleteComponent",
	"connectWire",
	"disconnectWire",
	"moveComponent",
	"renameComponent",
	"setComponentLocked",
	"setComponentHidden",
	"addGroup",
	"removeFromGroup",
	"deleteGroup",
	"changeGroupColor",
	"renameGroup",
	"changeGroupStyle",
	"createSlider",
	"editSliderRange",
	"setSliderValue",
	"createPanel",
	"setPanelParams",
	"setPanelText",
	"createToggle",
	"setToggleValue",
	"createSwatch",
	"setSwatchColor",
	"createScribble",
	"setScribbleText",
	"createValueList",
	"setValueListSelected",
	"createScriptNode",
	"setScriptCode",
	"syncScriptParams",
	"addScriptInput",
	"removeScriptInput",
	"addScriptOutput",
	"removeScriptOutput",
	"editParamProps",
	"beginAgentTransaction",
	"commitAgentTransaction",
	"cancelAgentTransaction",
	"beginRhinoAgentTransaction",
	"commitRhinoAgentTransaction",
	"cancelRhinoAgentTransaction",
	"setParamRhinoGeometry",
] as const;

export type QueryOperation = (typeof QUERY_OPERATIONS)[number];
export type ControlOperation = (typeof CONTROL_OPERATIONS)[number];
export type MutationOperation = (typeof MUTATION_OPERATIONS)[number];
export type OperationName = QueryOperation | ControlOperation | MutationOperation;
export type OperationClass = "query" | "control" | "mutation";

export const RHINO_RESULT_CLASSES = [
	"completed",
	"failed",
	"busy",
	"deadline_exceeded_before_start",
	"cancelled_before_start",
	"capability_unavailable",
	"no_active_grasshopper_document",
	"shutting_down",
] as const;

export const NODE_LOCAL_RESULT_CLASSES = ["outcome_unknown"] as const;

export type RhinoResultClass = (typeof RHINO_RESULT_CLASSES)[number];
export type NodeLocalResultClass = (typeof NODE_LOCAL_RESULT_CLASSES)[number];

export const REASON_CODES = [
	"OK",
	"AUTH_INVALID",
	"PROTOCOL_VERSION_UNSUPPORTED",
	"LIFECYCLE_INSTANCE_STALE",
	"MALFORMED_REQUEST",
	"UNKNOWN_OPERATION",
	"OPERATION_ID_REQUIRED",
	"OPERATION_ID_FORBIDDEN",
	"START_DEADLINE_EXCEEDED",
	"DISPATCHER_BUSY",
	"RESULT_STORE_FULL",
	"CANCELLED_BEFORE_START",
	"CAPABILITY_UNAVAILABLE",
	"GRASSHOPPER_NOT_INSTALLED",
	"GRASSHOPPER_START_FAILED",
	"NO_ACTIVE_GRASSHOPPER_DOCUMENT",
	"SHUTTING_DOWN",
	"OPERATION_FAILED",
	"OPERATION_RESULT_TOO_LARGE",
	"CANCELLATION_REJECTED_ALREADY_STARTED",
	"HANDSHAKE_REJECTED",
	"INTERNAL_ERROR",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type LifecycleHandshakeArgs = {
	nodeProcessId: number;
	nodeVersion: string;
	clientIdentity: string;
};

export type RecoveryOperationArgs = { operationId: string };

export type RequestArgsFor<O extends OperationName> =
	O extends "manageRhinoDocument" | "manageGrasshopperDocument" ? DocumentRequest
		: O extends "getRhinoDocument" | "getRhinoDocumentSettings" | "getGrasshopperDocument" | "getGrasshopperDocumentSettings" ? { documentId: string }
		: O extends "getDocumentTransactionState" ? { owner: "rhino" | "grasshopper" }
		: O extends "browseDocumentFiles" ? { kind: "rhino" | "grasshopper"; path: string; cursor?: string; limit?: number }
		: O extends "listRhinoDocuments" | "listGrasshopperDocuments" ? Record<string, never>
		: O extends "lifecycleHandshake" ? LifecycleHandshakeArgs
		: O extends "getRuntimeStatus" | "startGrasshopper" ? Record<string, never>
			: O extends "getOperationResult" | "cancelOperation" ? RecoveryOperationArgs
				: JsonObject;

type RequestBase<O extends OperationName> = {
	protocolVersion: typeof PROTOCOL_VERSION;
	lifecycleInstanceId: string;
	requestId: string;
	token: string;
	operation: O;
	startDeadlineAt: number;
	args: RequestArgsFor<O>;
};

export type QueryRequest<O extends QueryOperation = QueryOperation> = RequestBase<O>;
export type ControlRequest<O extends ControlOperation = ControlOperation> = RequestBase<O>;
export type MutationRequest<O extends MutationOperation = MutationOperation> = RequestBase<O> & {
	operationId: string;
};
export type HopperRpcRequest = QueryRequest | ControlRequest | MutationRequest;

export type RuntimeError = { code: ReasonCode; message: string };
export type LifecycleState = "stopped" | "starting" | "running" | "stopping" | "faulted";
export type GrasshopperState = "not_installed" | "not_loaded" | "loading" | "ready" | "failed";
export type HandshakeState = "disconnected" | "connecting" | "live" | "failed";

export type RuntimeStatus = {
	protocolVersion: typeof PROTOCOL_VERSION;
	revision: number;
	observedAt: number;
	lifecycle: {
		state: LifecycleState;
		changedAt: number;
		reason: RuntimeError | null;
	};
	transport: {
		ready: boolean;
		lifecycleInstanceId: string | null;
	};
	host: {
		state: LifecycleState;
		processId: number | null;
		nodePath: string | null;
		nodeVersion: string | null;
		handshake: HandshakeState;
		healthFailureCount: number;
	};
	rhino: {
		activeDocument: boolean;
		documentName: string | null;
	};
	grasshopper: {
		state: GrasshopperState;
		activeDocument: boolean;
		documentName: string | null;
	};
	dispatcher: {
		acceptingExternalWork: boolean;
		depth: number;
		capacity: number;
	};
	errors: {
		transport: RuntimeError | null;
		host: RuntimeError | null;
		rhino: RuntimeError | null;
		grasshopper: RuntimeError | null;
		dispatcher: RuntimeError | null;
	};
};

export type OperationResultSnapshot = {
	class: RhinoResultClass;
	reasonCode: ReasonCode;
	message?: string;
	data?: JsonValue;
};

export type RpcOperationResponse<O extends OperationName = OperationName> = {
	protocolVersion: typeof PROTOCOL_VERSION;
	lifecycleInstanceId: string;
	requestId: string;
	operation: O;
	operationId?: string;
	result: OperationResultSnapshot;
};

export const PROTOCOL_ERROR_REASON_CODES = [
	"AUTH_INVALID",
	"PROTOCOL_VERSION_UNSUPPORTED",
	"LIFECYCLE_INSTANCE_STALE",
	"MALFORMED_REQUEST",
	"UNKNOWN_OPERATION",
	"OPERATION_ID_REQUIRED",
	"OPERATION_ID_FORBIDDEN",
] as const;

export type ProtocolErrorReasonCode = (typeof PROTOCOL_ERROR_REASON_CODES)[number];
export type ProtocolErrorResponse = {
	protocolVersion: typeof PROTOCOL_VERSION;
	requestId: string;
	errorType: "protocol_error";
	lifecycleInstanceId: string | null;
	operation: string | null;
	result: {
		class: "failed";
		reasonCode: ProtocolErrorReasonCode;
		message: string;
	};
};

export type HopperRpcResponse = RpcOperationResponse | ProtocolErrorResponse;

export const ROUTER_DEALER_FRAMING = {
	transport: "zeromq-router-dealer",
	payloadEncoding: "utf-8-json",
	delimiterFrame: false,
	dealerToRouter: {
		dealerSends: ["payload"],
		routerReceives: ["routingIdentity", "payload"],
	},
	routerToDealer: {
		routerSends: ["routingIdentity", "payload"],
		dealerReceives: ["payload"],
	},
	routingIdentity: {
		encoding: "opaque-bytes",
		lifetime: "stable-for-node-process",
		includedInJson: false,
	},
} as const;

const queryOperations = new Set<string>(QUERY_OPERATIONS);
const controlOperations = new Set<string>(CONTROL_OPERATIONS);
const mutationOperations = new Set<string>(MUTATION_OPERATIONS);
const rhinoResultClasses = new Set<string>(RHINO_RESULT_CLASSES);
const reasonCodes = new Set<string>(REASON_CODES);
const protocolErrorReasonCodes = new Set<string>(PROTOCOL_ERROR_REASON_CODES);

const reasonsByClass: Record<RhinoResultClass, ReadonlySet<ReasonCode>> = {
	completed: new Set(["OK"]),
	failed: new Set([
		"AUTH_INVALID",
		"PROTOCOL_VERSION_UNSUPPORTED",
		"LIFECYCLE_INSTANCE_STALE",
		"MALFORMED_REQUEST",
		"UNKNOWN_OPERATION",
		"OPERATION_ID_REQUIRED",
		"OPERATION_ID_FORBIDDEN",
		"GRASSHOPPER_START_FAILED",
		"OPERATION_FAILED",
		"OPERATION_RESULT_TOO_LARGE",
		"CANCELLATION_REJECTED_ALREADY_STARTED",
		"HANDSHAKE_REJECTED",
		"INTERNAL_ERROR",
	]),
	busy: new Set(["DISPATCHER_BUSY", "RESULT_STORE_FULL"]),
	deadline_exceeded_before_start: new Set(["START_DEADLINE_EXCEEDED"]),
	cancelled_before_start: new Set(["CANCELLED_BEFORE_START"]),
	capability_unavailable: new Set([
		"CAPABILITY_UNAVAILABLE",
		"GRASSHOPPER_NOT_INSTALLED",
	]),
	no_active_grasshopper_document: new Set(["NO_ACTIVE_GRASSHOPPER_DOCUMENT"]),
	shutting_down: new Set(["SHUTTING_DOWN"]),
};

export function classifyOperation(operation: string): OperationClass | null {
	if (queryOperations.has(operation)) return "query";
	if (controlOperations.has(operation)) return "control";
	if (mutationOperations.has(operation)) return "mutation";
	return null;
}

export type ValidationResult<T> =
	| { ok: true; value: T }
	| { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || ["string", "boolean"].includes(typeof value)) return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isRecord(value) && Object.values(value).every(isJsonValue);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function validateInternalArgs(operation: OperationName, args: Record<string, unknown>): boolean {
	switch (operation) {
		case "lifecycleHandshake":
			return hasExactKeys(args, ["nodeProcessId", "nodeVersion", "clientIdentity"])
				&& Number.isSafeInteger(args.nodeProcessId) && Number(args.nodeProcessId) > 0
				&& typeof args.nodeVersion === "string" && /^v?\d+\.\d+\.\d+$/.test(args.nodeVersion)
				&& isIdentifier(args.clientIdentity);
		case "getRuntimeStatus":
		case "startGrasshopper":
			return hasExactKeys(args, []);
		case "getOperationResult":
		case "cancelOperation":
			return hasExactKeys(args, ["operationId"]) && isIdentifier(args.operationId);
		default:
			return Object.values(args).every(isJsonValue);
	}
}

export function validateRpcRequest(input: unknown): ValidationResult<HopperRpcRequest> {
	const errors: string[] = [];
	if (!isRecord(input)) return { ok: false, errors: ["request must be an object"] };
	const operationClass = typeof input.operation === "string" ? classifyOperation(input.operation) : null;
	const allowed = [
		"protocolVersion", "lifecycleInstanceId", "requestId", "token",
		"operation", "startDeadlineAt", "args",
		...(operationClass === "mutation" ? ["operationId"] : []),
	];
	if (!hasExactKeys(input, allowed)) errors.push("request envelope fields do not match the operation class");
	if (input.protocolVersion !== PROTOCOL_VERSION) errors.push("protocolVersion must be 2");
	if (!isIdentifier(input.lifecycleInstanceId)) errors.push("lifecycleInstanceId is invalid");
	if (!isIdentifier(input.requestId)) errors.push("requestId is invalid");
	if (typeof input.token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(input.token)) {
		errors.push("token must be a 32 to 128 character base64url value");
	}
	if (!operationClass) errors.push("operation is unknown");
	if (!Number.isSafeInteger(input.startDeadlineAt) || Number(input.startDeadlineAt) < 0) {
		errors.push("startDeadlineAt must be a non-negative safe integer");
	}
	if (!isRecord(input.args)) errors.push("args must be an object");
	else if (operationClass && !validateInternalArgs(input.operation as OperationName, input.args)) {
		errors.push("args are invalid for the operation");
	}
	if (operationClass === "mutation" && !isIdentifier(input.operationId)) {
		errors.push("operationId is required for mutations");
	}
	return errors.length === 0
		? { ok: true, value: input as HopperRpcRequest }
		: { ok: false, errors };
}

function isRuntimeError(value: unknown): value is RuntimeError {
	return isRecord(value)
		&& hasExactKeys(value, ["code", "message"])
		&& typeof value.code === "string" && reasonCodes.has(value.code)
		&& typeof value.message === "string" && value.message.length > 0;
}

function isNullableRuntimeError(value: unknown): boolean {
	return value === null || isRuntimeError(value);
}

export function isRuntimeStatus(value: unknown): value is RuntimeStatus {
	if (!isRecord(value) || !hasExactKeys(value, [
		"protocolVersion", "revision", "observedAt", "lifecycle", "transport",
		"host", "rhino", "grasshopper", "dispatcher", "errors",
	])) return false;
	if (value.protocolVersion !== PROTOCOL_VERSION
		|| !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
		|| !Number.isSafeInteger(value.observedAt) || Number(value.observedAt) < 0) return false;
	if (!isRecord(value.lifecycle) || !hasExactKeys(value.lifecycle, ["state", "changedAt", "reason"])
		|| !["stopped", "starting", "running", "stopping", "faulted"].includes(String(value.lifecycle.state))
		|| !Number.isSafeInteger(value.lifecycle.changedAt) || Number(value.lifecycle.changedAt) < 0
		|| !isNullableRuntimeError(value.lifecycle.reason)) return false;
	if (!isRecord(value.transport) || !hasExactKeys(value.transport, ["ready", "lifecycleInstanceId"])
		|| typeof value.transport.ready !== "boolean"
		|| !(value.transport.lifecycleInstanceId === null || isIdentifier(value.transport.lifecycleInstanceId))) return false;
	if (!isRecord(value.host) || !hasExactKeys(value.host, [
		"state", "processId", "nodePath", "nodeVersion", "handshake", "healthFailureCount",
	]) || !["stopped", "starting", "running", "stopping", "faulted"].includes(String(value.host.state))
		|| !(value.host.processId === null || Number.isSafeInteger(value.host.processId) && Number(value.host.processId) > 0)
		|| !(value.host.nodePath === null || typeof value.host.nodePath === "string")
		|| !(value.host.nodeVersion === null || typeof value.host.nodeVersion === "string")
		|| !["disconnected", "connecting", "live", "failed"].includes(String(value.host.handshake))
		|| !Number.isSafeInteger(value.host.healthFailureCount) || Number(value.host.healthFailureCount) < 0) return false;
	for (const part of [value.rhino, value.grasshopper]) {
		if (!isRecord(part) || typeof part.activeDocument !== "boolean"
			|| !(part.documentName === null || typeof part.documentName === "string")) return false;
	}
	if (!hasExactKeys(value.rhino as Record<string, unknown>, ["activeDocument", "documentName"])) return false;
	if (!hasExactKeys(value.grasshopper as Record<string, unknown>, ["state", "activeDocument", "documentName"])
		|| !["not_installed", "not_loaded", "loading", "ready", "failed"].includes(String((value.grasshopper as Record<string, unknown>).state))) return false;
	if (!isRecord(value.dispatcher) || !hasExactKeys(value.dispatcher, ["acceptingExternalWork", "depth", "capacity"])
		|| typeof value.dispatcher.acceptingExternalWork !== "boolean"
		|| !Number.isSafeInteger(value.dispatcher.depth) || Number(value.dispatcher.depth) < 0
		|| !Number.isSafeInteger(value.dispatcher.capacity) || Number(value.dispatcher.capacity) < 1
		|| Number(value.dispatcher.depth) > Number(value.dispatcher.capacity)) return false;
	if (!isRecord(value.errors) || !hasExactKeys(value.errors, ["transport", "host", "rhino", "grasshopper", "dispatcher"])
		|| !Object.values(value.errors).every(isNullableRuntimeError)) return false;
	return true;
}

function validateInternalResponseData(operation: OperationName, data: unknown): boolean {
	if (!isRecord(data)) return false;
	switch (operation) {
		case "lifecycleHandshake":
			return hasExactKeys(data, ["handshake", "statusRevision"])
				&& data.handshake === "live"
				&& Number.isSafeInteger(data.statusRevision) && Number(data.statusRevision) >= 0;
		case "getRuntimeStatus":
			return isRuntimeStatus(data);
		case "startGrasshopper":
			return hasExactKeys(data, ["state"])
				&& ["start_requested", "already_ready"].includes(String(data.state));
		case "getOperationResult": {
			if (data.state === "pending") {
				return hasExactKeys(data, ["state", "phase"])
					&& ["queued", "running"].includes(String(data.phase));
			}
			if (data.state === "not_found") return hasExactKeys(data, ["state"]);
			return data.state === "terminal"
				&& hasExactKeys(data, ["state", "result"])
				&& isOperationResultSnapshot(data.result);
		}
		case "cancelOperation":
			return hasExactKeys(data, ["state"])
				&& ["cancelled_before_start", "already_cancelled", "rejected_already_started", "not_found"].includes(String(data.state));
		default:
			return isJsonValue(data);
	}
}

function isOperationResultSnapshot(value: unknown): value is OperationResultSnapshot {
	if (!isRecord(value) || !hasOnlyKeys(value, ["class", "reasonCode", "message", "data"])
		|| !rhinoResultClasses.has(String(value.class)) || !reasonCodes.has(String(value.reasonCode))) return false;
	if (value.message !== undefined && typeof value.message !== "string") return false;
	if (value.data !== undefined && !isJsonValue(value.data)) return false;
	return reasonsByClass[value.class as RhinoResultClass].has(value.reasonCode as ReasonCode);
}

function isProtocolErrorResponse(input: Record<string, unknown>): input is ProtocolErrorResponse {
	if (!hasExactKeys(input, [
		"protocolVersion", "requestId", "errorType", "lifecycleInstanceId", "operation", "result",
	])) return false;
	if (input.protocolVersion !== PROTOCOL_VERSION || input.errorType !== "protocol_error"
		|| !isIdentifier(input.requestId)
		|| !(input.lifecycleInstanceId === null || isIdentifier(input.lifecycleInstanceId))
		|| !(input.operation === null || typeof input.operation === "string" && input.operation.length > 0 && input.operation.length <= 128)
		|| !isRecord(input.result)) return false;
	return hasExactKeys(input.result, ["class", "reasonCode", "message"])
		&& input.result.class === "failed"
		&& typeof input.result.reasonCode === "string" && protocolErrorReasonCodes.has(input.result.reasonCode)
		&& typeof input.result.message === "string" && input.result.message.length > 0;
}

export function validateRpcResponse(input: unknown): ValidationResult<HopperRpcResponse> {
	const errors: string[] = [];
	if (!isRecord(input)) return { ok: false, errors: ["response must be an object"] };
	if (input.errorType === "protocol_error") {
		return isProtocolErrorResponse(input)
			? { ok: true, value: input }
			: { ok: false, errors: ["protocol error response is invalid"] };
	}
	const operationClass = typeof input.operation === "string" ? classifyOperation(input.operation) : null;
	const allowed = [
		"protocolVersion", "lifecycleInstanceId", "requestId", "operation", "result",
		...(operationClass === "mutation" ? ["operationId"] : []),
	];
	if (!hasExactKeys(input, allowed)) errors.push("response envelope fields do not match the operation class");
	if (input.protocolVersion !== PROTOCOL_VERSION) errors.push("protocolVersion must be 2");
	if (!isIdentifier(input.lifecycleInstanceId)) errors.push("lifecycleInstanceId is invalid");
	if (!isIdentifier(input.requestId)) errors.push("requestId is invalid");
	if (!operationClass) errors.push("operation is unknown");
	if (operationClass === "mutation" && !isIdentifier(input.operationId)) {
		errors.push("operationId is required for mutation responses");
	}
	if (!isOperationResultSnapshot(input.result)) {
		errors.push("result class, reasonCode, or payload is invalid");
	} else if (operationClass && input.result.class === "completed"
		&& ["lifecycleHandshake", "getRuntimeStatus", "startGrasshopper", "getOperationResult", "cancelOperation"].includes(String(input.operation))
		&& !validateInternalResponseData(input.operation as OperationName, input.result.data)) {
		errors.push("completed control or status result data is invalid");
	}
	return errors.length === 0
		? { ok: true, value: input as RpcOperationResponse }
		: { ok: false, errors };
}
