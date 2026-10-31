import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime,
	SessionManager, type AgentSession, type CreateAgentSessionRuntimeFactory, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { isolatedResourceLoaderOptions, bindToolPolicyModelBoundary } from "./pi-runtime.js";
import { ToolPolicyRuntime } from "../services/tool-policy-runtime.js";
import { ToolPolicyStore } from "../services/tool-policy-store.js";
import { ToolCredentials } from "../services/tool-credentials.js";
import { HOPPER_POLICY_INVENTORY } from "../tools/policy-inventory.js";
import { BrowserUiContext } from "./web-ui-context.js";
import { HostMessageBus } from "./message-bus.js";

vi.mock("../infra/backend-status.js", () => ({
	getCachedBackendStatus: () => ({ online: true }),
	probeBackend: async () => ({ online: true }),
	refreshBackendIfOffline: async () => true,
	formatBackendEndpoint: () => "offline-test-fixture",
}));
vi.mock("../infra/runtime-rpc.js", async importOriginal => ({
	...await importOriginal<typeof import("../infra/runtime-rpc.js")>(),
	beginRuntimeAgentTurn: vi.fn(), commitRuntimeAgentTurn: vi.fn(async () => {}), cancelRuntimeAgentTurn: vi.fn(async () => {}),
}));

const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network calls are forbidden in this suite"); })); });
afterEach(async () => {
	for (const dispose of cleanup.splice(0)) await dispose();
	vi.unstubAllGlobals();
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "hopper-policy-sdk-"));
	const secrets = new Map<string, string>();
	let policy!: ToolPolicyRuntime;
	const errors: unknown[] = [];
	const ui = new BrowserUiContext(new HostMessageBus());
	const readCalls = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Skill text" }], details: {} }));
	const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
		const store = new ToolPolicyStore(HOPPER_POLICY_INVENTORY, { directory: join(root, "profile") });
		// Execution must remain authoritative even when notification delivery is paused.
		vi.spyOn(store, "subscribe").mockImplementation(() => () => {});
		const credentials = new ToolCredentials(store, "firecrawl", {
			read: async id => secrets.get(id) ?? null,
			write: async (id, value) => { secrets.set(id, value); },
			remove: async id => { secrets.delete(id); },
		});
		policy = new ToolPolicyRuntime({ embedded: true, store, credentials: new Map([["firecrawl", credentials]]) });
		const services = await createAgentSessionServices({
			cwd: root, agentDir: join(root, "agent"),
			resourceLoaderOptions: isolatedResourceLoaderOptions({ toolPolicy: policy, scriptWorkspaceDir: join(root, "scripts"), sessionId: () => sessionManager.getSessionId() }),
		});
		const model = services.modelRuntime.getModels("anthropic").find(model => model.input.includes("image"))!;
		expect(model).toBeDefined();
		const customTools: ToolDefinition[] = [policy.customTool({ name: "read", label: "Read skill", description: "Read skill", parameters: Type.Object({}), execute: readCalls })];
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, noTools: "builtin", model, customTools });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(factory, { cwd: root, agentDir: join(root, "agent"), sessionManager: SessionManager.inMemory(root) });
	const bind = async (session: AgentSession) => session.bindExtensions({ uiContext: ui.context, mode: "rpc", onError: error => errors.push(error) });
	runtime.setRebindSession(bind);
	cleanup.push(async () => { ui.cancelAll(); await runtime.dispose(); await policy.close(); await rm(root, { recursive: true, force: true }); });
	await bind(runtime.session);
	expect(errors).toEqual([]);
	const patch = async (id: string, enabled: boolean, target: "tools" | "parents" = "tools") => {
		const result = await policy.store.update(await policy.store.read(), { id, enabled, target });
		expect(result.ok).toBe(true);
	};
	return { runtime, get policy() { return policy; }, patch, errors, readCalls };
}

describe("real Pi SDK tool policy integration without network", () => {

	it("a real newSession preserves disables and recreates guarded choice and capture tools", async () => {
		const f = await fixture();
		await f.patch("hopper.tool.rh_run_script", false);
		await f.patch("hopper.tool.ask_user", false);
		const previousId = f.runtime.session.sessionId;
		await f.runtime.newSession();
		expect(f.runtime.session.sessionId).not.toBe(previousId);
		expect(f.errors).toEqual([]);
		expect(f.runtime.session.getActiveToolNames()).not.toContain("rh_run_script");
		expect(f.runtime.session.getActiveToolNames()).not.toContain("ask_user");
		expect(f.runtime.session.getActiveToolNames()).toContain("pick_option");
		expect(f.runtime.session.getAllTools().map(tool => tool.name)).toContain("rh_capture_view");
	});

	it.each([true, false])("refreshes tool definitions before a continuation, embedded hook=%s", async embeddedHook => {
		const f = await fixture();
		const session = f.runtime.session;
		if (embeddedHook) bindToolPolicyModelBoundary(session, f.policy);
		await session.modelRuntime.setRuntimeApiKey("anthropic", "offline-model-key");
		const requests: string[][] = [];
		let started!: () => void;
		const firstStarted = new Promise<void>(resolve => { started = resolve; });
		let completeFirst!: () => void;
		session.agent.streamFunction = (model) => {
			requests.push(session.agent.state.tools.map(tool => tool.name));
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
				content: [], stopReason: "stop",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			stream.push({ type: "start", partial: message });
			if (requests.length === 1) {
				completeFirst = () => {
					const complete: AssistantMessage = { ...message, stopReason: "toolUse", content: [{ type: "toolCall", id: "read-for-continuation", name: "read", arguments: {} }] };
					stream.push({ type: "done", reason: "toolUse", message: complete });
				};
				started();
			} else stream.push({ type: "done", reason: "stop", message: { ...message, content: [{ type: "text", text: "Finished." }] } });
			return stream;
		};
		const prompt = session.prompt("Read the available skill.", { source: "rpc" });
		await firstStarted;
		expect(requests[0]).toContain("rh_run_script");
		expect(requests[0]).not.toContain("web_search");
		expect(f.policy.isBusy()).toBe(true);
		const disable = await f.policy.updateToolSettings({ type: "patch", expected: await f.policy.store.read(), patch: { target: "tools", id: "hopper.tool.rh_run_script", enabled: false } });
		expect(disable.ok).toBe(true);
		const enable = await f.policy.updateToolSettings({ type: "credential", pluginId: "firecrawl", action: "save-and-enable", expected: await f.policy.store.read(), key: "memory-only-key" });
		expect(enable.ok).toBe(true);
		expect(session.getActiveToolNames()).not.toContain("web_search");
		completeFirst();
		await prompt;
		expect(requests).toHaveLength(2);
		expect(requests[1]).not.toContain("rh_run_script");
		expect(requests[1]).toContain("web_search");
		expect(f.readCalls).toHaveBeenCalledOnce();
		expect(fetch).not.toHaveBeenCalled();
	});
});
