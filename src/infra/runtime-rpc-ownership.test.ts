import { describe, expect, it } from "vitest";
import {
	CONTROL_OPERATIONS,
	MUTATION_OPERATIONS,
	QUERY_OPERATIONS,
	type OperationName,
	type RequestArgsFor,
	type RpcOperationResponse,
	type RuntimeStatus,
} from "../protocol/v2.js";
import type { RpcCallOptions, RpcCallResult } from "./rpc-client.js";
import type { RuntimeStatusEventSource } from "./grasshopper-readiness.js";
import {
	RPC_OPERATION_OWNERS,
	RuntimeRpc,
	requiresGrasshopper,
	type RpcOperationOwner,
	type RuntimeRpcTransport,
} from "./runtime-rpc.js";

const lifecycleInstanceId = "life-ownership-test";

const expectedOperations = {
	core: [
		"browseDocumentFiles",
		"getDocumentTransactionState",
		"getRuntimeStatus",
		"getOperationResult",
		"lifecycleHandshake",
		"startGrasshopper",
		"cancelOperation",
	],
	rhino: [
		"listRhinoDocuments", "getRhinoDocument", "getRhinoDocumentSettings", "manageRhinoDocument",
		"queryRhinoObjects",
		"captureRhinoView",
		"runRhinoScript",
		"controlRhinoView",
		"beginRhinoAgentTransaction",
		"commitRhinoAgentTransaction",
		"cancelRhinoAgentTransaction",
	],
	grasshopper: [
		"listGrasshopperDocuments", "getGrasshopperDocument", "getGrasshopperDocumentSettings", "manageGrasshopperDocument",
		"listAllComponents",
		"getCurrentCanvas",
		"getCanvasErrors",
		"listScriptParams",
		"getScriptCode",
		"getParamRhinoGeometry",
		"applyGraph",
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
		"setParamRhinoGeometry",
	],
} as const satisfies Record<RpcOperationOwner, readonly OperationName[]>;

const ownershipCases = Object.entries(expectedOperations).flatMap(([owner, operations]) =>
	operations.map((operation) => ({ owner: owner as RpcOperationOwner, operation })),
);

describe("RPC operation ownership", () => {
	it("classifies every protocol operation exactly once", () => {
		const protocolOperations = [
			...QUERY_OPERATIONS,
			...CONTROL_OPERATIONS,
			...MUTATION_OPERATIONS,
		].sort();
		const classifiedOperations = Object.keys(RPC_OPERATION_OWNERS).sort();
		const expectedClassifications = Object.fromEntries(
			ownershipCases.map(({ operation, owner }) => [operation, owner]),
		);

		expect(classifiedOperations).toEqual(protocolOperations);
		expect(RPC_OPERATION_OWNERS).toEqual(expectedClassifications);
		expect(new Set(ownershipCases.map(({ operation }) => operation)).size).toBe(protocolOperations.length);
	});

	it.each(ownershipCases)(
		"routes $operation to $owner readiness",
		async ({ operation, owner }) => {
			const transport = new FakeTransport();
			const events = new FakeEvents();
			const runtime = new RuntimeRpc({
				lifecycleInstanceId,
				transport,
				events,
				nodeProcessId: 42,
				nodeVersion: "v22.19.0",
			});

			await runtime.invoke(operation, argsFor(operation) as never);

			const needsReadiness = owner === "grasshopper" && !["listGrasshopperDocuments", "getGrasshopperDocument", "getGrasshopperDocumentSettings"].includes(operation);
			expect(requiresGrasshopper(operation)).toBe(needsReadiness);
			expect(events.subscribeCount).toBe(needsReadiness ? 1 : 0);
		},
	);
});

function argsFor(operation: OperationName): Record<string, unknown> {
	if (operation === "lifecycleHandshake") {
		return { nodeProcessId: 42, nodeVersion: "v22.19.0", clientIdentity: "node-ownership-test" };
	}
	if (operation === "getOperationResult" || operation === "cancelOperation") {
		return { operationId: "operation-1" };
	}
	return {};
}

class FakeTransport implements RuntimeRpcTransport {
	readonly identity = "node-ownership-test";

	async connect(): Promise<void> { }
	async close(): Promise<void> { }

	async call<O extends OperationName>(
		operation: O,
		_args: RequestArgsFor<O>,
		_options?: RpcCallOptions,
	): Promise<RpcCallResult> {
		return response(
			operation,
			operation === "getRuntimeStatus"
				? readyStatus()
				: operation === "lifecycleHandshake"
					? { handshake: "live", statusRevision: 1 }
					: { operation },
		);
	}
}

class FakeEvents implements RuntimeStatusEventSource {
	subscribeCount = 0;

	async subscribe(_onWakeup: () => void): Promise<() => void> {
		this.subscribeCount++;
		return () => { };
	}
}

function response(operation: OperationName, data: unknown): RpcOperationResponse {
	return {
		protocolVersion: 2,
		lifecycleInstanceId,
		requestId: `request-${operation}`,
		operation,
		result: { class: "completed", reasonCode: "OK", data: data as never },
	};
}

function readyStatus(): RuntimeStatus {
	return {
		protocolVersion: 2,
		revision: 1,
		observedAt: 1,
		lifecycle: { state: "running", changedAt: 1, reason: null },
		transport: { ready: true, lifecycleInstanceId },
		host: {
			state: "running",
			processId: 42,
			nodePath: "/usr/local/bin/node",
			nodeVersion: "22.19.0",
			handshake: "live",
			healthFailureCount: 0,
		},
		rhino: { activeDocument: true, documentName: "model.3dm" },
		grasshopper: { state: "ready", activeDocument: true, documentName: "definition.gh" },
		dispatcher: { acceptingExternalWork: true, depth: 0, capacity: 64 },
		errors: { transport: null, host: null, rhino: null, grasshopper: null, dispatcher: null },
	};
}
