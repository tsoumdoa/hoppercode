import { describe, expect, it, vi } from "vitest";
import { RuntimeSessionContext } from "./runtime-session-context.js";
import { beginRuntimeAgentTurn, cancelRuntimeAgentTurn, closeRuntimeRpc, commitRuntimeAgentTurn, getRuntimeRpc, type RuntimeRpc } from "./runtime-rpc.js";
import { clearDocumentGuidAliases, resolveInstanceGuid, resolveRhinoGuid, toShortInstanceGuid, toShortRhinoGuid } from "../services/guid-shortener.js";
import { getCachedBackendStatus, setCachedBackendStatus } from "./backend-status-cache.js";
import { resolveConnection, type ConnectionConfig } from "./connection.js";
import { runtimeScriptBackend } from "../services/rhino-script-execution.js";

function makeSession(id: string) {
	const runtime = {
		lifecycleInstanceId: id,
		beginAgentTurn: vi.fn(),
		commitAgentTurn: vi.fn(async () => {}),
		cancelAgentTurn: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
		invoke: vi.fn(async () => ({ result: { data: { documents: [], activeDocumentId: null } } })),
	};
	const connection: ConnectionConfig = {
		lifecycleInstanceId: id, rpcEndpoint: `tcp://${id}:5557`, pubEndpoint: `tcp://${id}:5555`,
		token: id.repeat(32), profilePath: `/${id}/connection.json`, source: "profile",
	};
	const createRuntime = vi.fn(() => runtime as unknown as RuntimeRpc);
	return { context: new RuntimeSessionContext({ connection, createRuntime }), runtime, connection, createRuntime };
}

describe("RuntimeSessionContext", () => {
	it("keeps interleaved asynchronous aliases, RPC, connection and status state in their session", async () => {
		const a = makeSession("a"), b = makeSession("b");
		const full = "11111111-2222-3333-4444-555555555555";
		let releaseA!: () => void;
		const gate = new Promise<void>((resolve) => { releaseA = resolve; });
		let alias = "";
		const first = a.context.run(async () => {
			alias = toShortRhinoGuid(full);
			toShortInstanceGuid(full);
			setCachedBackendStatus({ online: false });
			beginRuntimeAgentTurn();
			expect(getRuntimeRpc()).toBe(a.runtime);
			await gate;
			expect(resolveRhinoGuid(alias)).toBe(full);
			expect(resolveInstanceGuid(alias)).toBe(full);
			expect(getCachedBackendStatus()).toEqual({ online: false });
			expect(resolveConnection({ refresh: true })).toBe(a.connection);
			await runtimeScriptBackend().target();
			await commitRuntimeAgentTurn();
		});
		await b.context.run(async () => {
			expect(resolveRhinoGuid(alias)).toBe(alias);
			expect(resolveInstanceGuid(alias)).toBe(alias);
			expect(getCachedBackendStatus()).toBeNull();
			toShortRhinoGuid(full);
			clearDocumentGuidAliases("rhino");
			clearDocumentGuidAliases("grasshopper");
			setCachedBackendStatus({ online: true });
			expect(resolveConnection()).toBe(b.connection);
			beginRuntimeAgentTurn();
			expect(getRuntimeRpc()).toBe(b.runtime);
			await runtimeScriptBackend().target();
			await cancelRuntimeAgentTurn();
			await closeRuntimeRpc();
		});
		releaseA();
		await first;
		expect(a.runtime.beginAgentTurn).toHaveBeenCalledTimes(1);
		expect(a.runtime.commitAgentTurn).toHaveBeenCalledTimes(1);
		expect(a.runtime.cancelAgentTurn).not.toHaveBeenCalled();
		expect(a.runtime.close).not.toHaveBeenCalled();
		expect(b.runtime.commitAgentTurn).not.toHaveBeenCalled();
		expect(b.runtime.cancelAgentTurn).toHaveBeenCalledTimes(1);
		expect(b.runtime.close).toHaveBeenCalledTimes(1);
		expect(a.runtime.invoke).toHaveBeenCalledTimes(1);
		expect(b.runtime.invoke).toHaveBeenCalledTimes(1);
		expect(a.createRuntime).toHaveBeenCalledTimes(1);
		expect(b.createRuntime).toHaveBeenCalledTimes(1);
	});
});
