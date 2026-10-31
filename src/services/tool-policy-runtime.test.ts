import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { ToolPolicyRuntime } from "./tool-policy-runtime.js";
import { ToolPolicyStore } from "./tool-policy-store.js";
import { ToolCredentials } from "./tool-credentials.js";
import { HOPPER_POLICY_INVENTORY } from "../tools/policy-inventory.js";
import { HopperRpcClient, type DealerSocket } from "../infra/rpc-client.js";

const backend = vi.hoisted(() => ({ online: true, probe: vi.fn(), refresh: vi.fn() }));
vi.mock("../infra/backend-status.js", () => ({
	getCachedBackendStatus: () => ({ online: backend.online }),
	probeBackend: () => backend.probe(),
	refreshBackendIfOffline: () => backend.refresh(),
}));

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
	backend.online = true;
	backend.probe.mockReset().mockImplementation(async () => { backend.online = true; });
	backend.refresh.mockReset().mockResolvedValue(true);
});
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(progressive = false) {
	const directory = await mkdtemp(join(tmpdir(), "hopper-runtime-policy-"));
	const store = new ToolPolicyStore(HOPPER_POLICY_INVENTORY, { directory });
	// Deliberately miss notifications: execution must still read the authoritative store.
	vi.spyOn(store, "subscribe").mockImplementation(() => () => {});
	const secrets = new Map<string, string>();
	const credentials = new ToolCredentials(store, "firecrawl", {
		read: async id => secrets.get(id) ?? null,
		write: async (id, value) => { secrets.set(id, value); },
		remove: async id => { secrets.delete(id); },
	});
	const runtime = new ToolPolicyRuntime({ store, credentials: new Map([["firecrawl", credentials]]) });
	cleanups.push(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
	let active: string[] = [];
	const registered = new Map<string, ToolDefinition>();
	const pi = {
		getAllTools: () => [...registered.values()], getActiveTools: () => active,
		setActiveTools: vi.fn((names: string[]) => { active = names; }),
		registerTool: (tool: ToolDefinition) => { registered.set(tool.name, tool); },
	} as unknown as ExtensionAPI;
	const context = (id: string) => ({ sessionManager: { getSessionId: () => id }, hasUI: true, model: { input: ["text"] } }) as unknown as ExtensionContext;
	let ctx = context("first");
	runtime.bind(pi, ctx, progressive);
	const tool = (name: string, execute: ToolDefinition["execute"]) => {
		runtime.register(pi, { name, label: name, description: name, parameters: Type.Object({}), execute });
		return registered.get(name)!;
	};
	const invoke = (definition: ToolDefinition) => definition.execute("test", {}, undefined, undefined, ctx);
	const patch = async (id: string, enabled: boolean, target: "tools" | "parents" = "tools") => {
		const result = await store.update(await store.read(), { id, enabled, target });
		expect(result.ok).toBe(true);
	};
	const enableFirecrawl = async () => {
		const saved = await credentials.save(await store.read(), "test-secret", true);
		expect(saved.ok).toBe(true);
	};
	return { runtime, store, credentials, pi, tool, invoke, patch, enableFirecrawl,
		replaceSession: () => { ctx = context("replacement"); runtime.bind(pi, ctx, progressive); } };
}

const completed = () => ({ content: [{ type: "text" as const, text: "done" }], details: {} });

async function withoutCredentialTimeout<T>(pending: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([pending, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("Still waiting on obsolete credentials")), 500);
		})]);
	} finally { clearTimeout(timer); }
}

describe("shared runtime policy admissions", () => {
	it.each(["local-save", "watcher", "missed-watcher"])("releases a credential read started before Firecrawl was disabled via %s", async source => {
		const f = await fixture();
		f.tool("rh_run_script", async () => completed());
		f.tool("web_search", async () => completed());
		await f.enableFirecrawl();
		await f.runtime.reconcile();
		const started = deferred(), resume = deferred<string | null>();
		vi.spyOn(f.credentials, "read").mockImplementationOnce(() => { started.resolve(); return resume.promise; });
		const publish = vi.fn();
		f.runtime.onChange = publish;
		const obsolete = f.runtime.reconcile();
		await started.promise;
		try {
			if (source === "local-save") {
				const result = await withoutCredentialTimeout(f.runtime.updateToolSettings({
					type: "patch", expected: await f.store.read(), patch: { target: "parents", id: "firecrawl", enabled: false },
				}));
				expect(result.ok).toBe(true);
			} else {
				await f.patch("firecrawl", false, "parents");
				if (source === "watcher") {
					vi.mocked(f.store.subscribe).mock.calls[0][0](await f.store.read());
					await withoutCredentialTimeout(obsolete);
				}
			}
			await withoutCredentialTimeout(f.runtime.reconcile(true));
			await obsolete;
			expect(f.pi.getActiveTools()).toContain("rh_run_script");
			expect(f.pi.getActiveTools()).not.toContain("web_search");
			const notifications = publish.mock.calls.length;
			resume.resolve("late-secret");
			await new Promise(resolve => setImmediate(resolve));
			expect(publish).toHaveBeenCalledTimes(notifications);
			expect(f.pi.getActiveTools()).not.toContain("web_search");
		} finally { resume.resolve(null); await obsolete; }
	});

	it("session replacement releases an old credential wait and ignores its late completion", async () => {
		const f = await fixture();
		f.tool("rh_run_script", async () => completed());
		f.tool("web_search", async () => completed());
		await f.enableFirecrawl();
		await f.runtime.reconcile();
		const started = deferred(), resume = deferred<string | null>();
		vi.spyOn(f.credentials, "read").mockImplementationOnce(() => { started.resolve(); return resume.promise; });
		const obsolete = f.runtime.reconcile().catch(error => error);
		await started.promise;
		try {
			f.replaceSession();
			await withoutCredentialTimeout(f.runtime.reconcile(true));
			expect(await obsolete).toMatchObject({ code: "cancelled" });
			expect(f.pi.getActiveTools()).toEqual(expect.arrayContaining(["rh_run_script", "web_search"]));
			const publish = vi.fn();
			f.runtime.onChange = publish;
			resume.resolve(null);
			await new Promise(resolve => setImmediate(resolve));
			expect(publish).not.toHaveBeenCalled();
			expect(f.pi.getActiveTools()).toContain("web_search");
		} finally { resume.resolve(null); await obsolete; }
	});

	it("does not reuse credential status after a concurrent key replacement", async () => {
		const f = await fixture();
		f.tool("web_search", async () => completed());
		await f.enableFirecrawl();
		const started = deferred(), resume = deferred();
		vi.spyOn(f.credentials, "status").mockImplementationOnce(async () => {
			started.resolve();
			await resume.promise;
			return "configured";
		});
		const publish = vi.fn();
		f.runtime.onChange = publish;
		const pending = f.runtime.reconcile();
		await started.promise;
		const saved = await f.credentials.save(await f.store.read(), "replacement-secret", false);
		expect(saved.ok).toBe(true);
		resume.resolve();
		await pending;
		expect(f.pi.getActiveTools()).not.toContain("web_search");
		expect(publish).toHaveBeenCalledOnce();
		expect(publish.mock.calls[0][0].settings.parents.find((parent: { id: string }) => parent.id === "firecrawl")?.credential?.status).toBe("unavailable");
	});

	it("revokes execution after a paused backend prerequisite despite missed notifications", async () => {
		const f = await fixture();
		const execute = vi.fn(async () => completed());
		const tool = f.tool("rh_run_script", execute);
		await f.runtime.reconcile();
		backend.online = false;
		const started = deferred(), resume = deferred();
		backend.probe.mockImplementation(async () => { started.resolve(); await resume.promise; backend.online = true; });
		const pending = f.invoke(tool);
		await started.promise;
		await f.patch("hopper.tool.rh_run_script", false);
		resume.resolve();
		expect((await pending).details).toMatchObject({ code: "disabled-by-user" });
		expect(execute).not.toHaveBeenCalled();
	});

	it("the actual RPC socket checks ALS admission for each send in a batch", async () => {
		const f = await fixture();
		const sent: unknown[] = [];
		let receive!: (frames: readonly Uint8Array[]) => void;
		let disconnect!: (error: Error) => void;
		const socket: DealerSocket = {
			connect: () => {},
			receive: () => new Promise((resolve, reject) => { receive = resolve; disconnect = reject; }),
			close: () => { disconnect?.(new Error("closed")); },
			send: async payload => {
				const request = JSON.parse(new TextDecoder().decode(payload));
				sent.push(request);
				await f.patch("hopper.tool.rh_run_script", false);
				receive([new TextEncoder().encode(JSON.stringify({
					protocolVersion: 2, lifecycleInstanceId: request.lifecycleInstanceId, requestId: request.requestId,
					operation: request.operation, result: { class: "completed", reasonCode: "OK", data: {} },
				}))]);
			},
		};
		const client = new HopperRpcClient({ endpoint: "tcp://127.0.0.1:5557", lifecycleInstanceId: "test-policy", token: "a".repeat(40), socketFactory: { create: () => socket } });
		const tool = f.tool("rh_run_script", async () => {
			await client.call("getCurrentCanvas", {});
			await client.call("getCurrentCanvas", {});
			return completed();
		});
		try {
			await f.runtime.reconcile();
			expect((await f.invoke(tool)).details).toMatchObject({ code: "disabled-by-user" });
			expect(sent).toHaveLength(1);
			expect(client.pendingCount).toBe(0);
		} finally { await client.close(); }
	});

	it("does not dispatch a local tool after session replacement during lock release", async () => {
		const f = await fixture();
		const execute = vi.fn(async () => completed());
		const tool = f.tool("rh_script", execute);
		await f.runtime.reconcile();
		const withSnapshot = f.store.withSnapshot.bind(f.store);
		vi.spyOn(f.store, "withSnapshot").mockImplementation(async fn => {
			const result = await withSnapshot(fn);
			// Replace the session during asynchronous release of the preflight lock.
			f.replaceSession();
			return result;
		});
		expect((await f.invoke(tool)).details).toMatchObject({ code: "cancelled" });
		expect(execute).not.toHaveBeenCalled();
	});

	it("key removal during a protected read blocks dispatch", async () => {
		const f = await fixture();
		f.tool("web_search", async () => completed());
		await f.enableFirecrawl();
		await f.runtime.reconcile();
		const started = deferred(), resume = deferred();
		const read = f.credentials.read.bind(f.credentials);
		vi.spyOn(f.credentials, "read").mockImplementationOnce(async snapshot => { const key = await read(snapshot); started.resolve(); await resume.promise; return key; });
		const pending = expect(f.runtime.admitPlugin("firecrawl", "web_search")).rejects.toMatchObject({ code: "credential-changed" });
		await started.promise;
		await f.credentials.remove(await f.store.read());
		resume.resolve();
		await pending;
	});

	it("pending manual activation cannot survive disable then enable during prerequisites", async () => {
		const f = await fixture(true);
		f.tool("web_search", async () => completed());
		await f.enableFirecrawl();
		await f.runtime.reconcile();
		const started = deferred(), resume = deferred();
		vi.spyOn(f.credentials, "status").mockImplementationOnce(async () => { started.resolve(); await resume.promise; return "configured"; });
		const pending = expect(f.runtime.activate("firecrawl.tool.search")).rejects.toMatchObject({ code: "activation-superseded" });
		await started.promise;
		await f.patch("firecrawl", false, "parents");
		await f.patch("firecrawl", true, "parents");
		resume.resolve();
		await pending;
		await f.runtime.reconcile();
		expect(f.pi.getActiveTools()).not.toContain("web_search");
	});
});
