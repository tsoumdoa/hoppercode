import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveHostConfig } from "./config.js";
import { isolatedResourceLoaderOptions, providerAuthMethods } from "./pi-runtime.js";

describe("embedded Pi isolation", () => {
	it("loads only Hopper factories; the host supplies the skill catalog", () => {
		const options = isolatedResourceLoaderOptions();
		expect(options).toMatchObject({
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		expect(options.extensionFactories).toEqual([
			expect.objectContaining({ name: "hopper", factory: expect.any(Function) }),
			expect.objectContaining({ name: "hopper-choices", factory: expect.any(Function) }),
		]);
	});

	it("advertises only provider auth methods that can start a login", () => {
		expect(providerAuthMethods({
			apiKey: { name: "Example API key", login: () => undefined },
			oauth: { name: "Example account", loginLabel: "Sign in with Example" },
		})).toEqual([
			{ type: "api_key", label: "Example API key" },
			{ type: "oauth", label: "Sign in with Example" },
		]);
		expect(providerAuthMethods({ apiKey: { name: "Ambient credentials" } })).toEqual([]);
	});
});

it("keeps skill changes out of prompt preparation and an active turn", async () => {
	const { EmbeddedPiHost } = await import("./pi-runtime.js");
	let finishScan!: () => void;
	let finishTurn!: () => void;
	const scanning = new Promise<void>((resolve) => { finishScan = resolve; });
	const turning = new Promise<void>((resolve) => { finishTurn = resolve; });
	let updateCount = 0;
	let rebuilt = 0;
	const skills = {
		refresh: () => scanning,
		expandCommand: (text: string) => text,
		update: async () => { updateCount++; },
		snapshot: () => ({ folder: "/skills", skills: [], diagnostics: [] }),
	};
	const session = {
		model: {}, isStreaming: false, isCompacting: false,
		getActiveToolNames: () => ["read", "rh_run_script"],
		setActiveToolsByName: () => { rebuilt++; },
		prompt: () => turning,
	};
	const host = Reflect.construct(EmbeddedPiHost, [{ session }, {}, {}, skills]) as import("./pi-runtime.js").EmbeddedPiHost;
	const turn = host.prompt("Create a sphere");
	const change = host.updateSkills({ type: "toggle", id: "rhino", enabled: false });
	const rejection = expect(change).rejects.toThrow("Wait until Hopper finishes");
	finishScan();
	await rejection;
	expect(rebuilt).toBe(1);
	expect(updateCount).toBe(0);
	await expect(host.updateSkills({ type: "toggle", id: "rhino", enabled: false })).rejects.toThrow("Wait until Hopper finishes");
	finishTurn();
	await turn;
	await host.updateSkills({ type: "toggle", id: "rhino", enabled: false });
	expect(updateCount).toBe(1);
});

it.each(["abort", "newSession"] as const)("%s cancels a prompt waiting for discovery and allows the next prompt", async (action) => {
	const { EmbeddedPiHost } = await import("./pi-runtime.js");
	let finishScan!: () => void;
	const scanning = new Promise<void>((resolve) => { finishScan = resolve; });
	const session = {
		model: {}, isStreaming: false, isCompacting: false,
		getActiveToolNames: () => [], setActiveToolsByName: vi.fn(),
		prompt: vi.fn(async () => {}), abort: vi.fn(async () => {}),
	};
	const runtime = { session, newSession: vi.fn(async () => {}) };
	const skills = { refresh: () => scanning, expandCommand: (text: string) => text };
	const host = Reflect.construct(EmbeddedPiHost, [runtime, {}, {}, skills]) as import("./pi-runtime.js").EmbeddedPiHost;
	const turn = host.prompt("Create a sphere");
	const cancelled = expect(turn).rejects.toThrow("Prompt cancelled before it started");
	const stopping = host[action]();
	finishScan();
	await stopping;
	await cancelled;
	expect(session.prompt).not.toHaveBeenCalled();
	await host.prompt("Create a cube");
	expect(session.prompt).toHaveBeenCalledExactlyOnceWith("Create a cube", { source: "rpc" });
});

it("persists skill choices and the selected model across host restarts and new instances", async () => {
	const { EmbeddedPiHost } = await import("./pi-runtime.js");
	const backend = await import("../infra/backend-status.js");
	const probe = vi.spyOn(backend, "probeBackend").mockResolvedValue({ online: false });
	const root = await mkdtemp(join(tmpdir(), "hopper-preferences-"));
	const paths = resolveHostConfig(["--data-dir", root, "--auth-path", join(root, "auth.json")]).paths;
	let host: import("./pi-runtime.js").EmbeddedPiHost | undefined;
	try {
		// Fake credentials allow local model selection; this test sends no model requests.
		await writeFile(paths.authPath, JSON.stringify({ anthropic: { type: "api_key", key: "test-only-not-a-real-key" } }));
		host = await EmbeddedPiHost.create({ paths, projectRoot: resolve(".") });
		const models = host.snapshot().models.filter((model) => model.provider === "anthropic");
		expect(models.length).toBeGreaterThan(1);
		const selected = models.find((model) => model.id !== host!.snapshot().model?.id)!;
		const custom = join(root, "custom-markdown");
		await mkdir(custom);
		await writeFile(join(custom, "office.md"), "# Office rules");
		const library = await host.updateSkills({ type: "folder", folder: custom });
		const userSkill = library.skills.find((skill) => skill.source === "user")!;
		const bundled = library.skills.find((skill) => skill.source === "bundled")!;
		await host.updateSkills({ type: "toggle", id: userSkill.id, enabled: false });
		await host.updateSkills({ type: "toggle", id: bundled.id, enabled: false });
		await host.updateSkills({ type: "toggle", id: bundled.id, enabled: true });
		await host.setModel(selected.provider, selected.id);
		expect(JSON.parse(await readFile(join(paths.agentDir, "settings.json"), "utf8"))).toMatchObject({
			defaultProvider: selected.provider, defaultModel: selected.id,
		});
		expect(JSON.parse(await readFile(join(root, "skills-settings.json"), "utf8"))).toMatchObject({
			folder: library.folder, disabled: [userSkill.id],
		});
		await host.dispose();
		host = undefined;
		// A different Rhino instance has a fresh workspace but shares the saved preferences.
		const nextPaths = resolveHostConfig(["--data-dir", root, "--auth-path", paths.authPath, "--instance-id", "another-window"]).paths;
		host = await EmbeddedPiHost.create({ paths: nextPaths, projectRoot: resolve(".") });
		expect(host.snapshot().model).toMatchObject({ provider: selected.provider, id: selected.id });
		const restored = await host.listSkills();
		expect(restored.folder).toBe(library.folder);
		expect(restored.skills.find((skill) => skill.id === userSkill.id)?.enabled).toBe(false);
		expect(restored.skills.find((skill) => skill.id === bundled.id)?.enabled).toBe(true);
		await host.newSession();
		expect(host.snapshot().model).toMatchObject({ provider: selected.provider, id: selected.id });
		// A failed disk write must be reported instead of claiming the preference was saved.
		const settingsPath = join(paths.agentDir, "settings.json");
		await rm(settingsPath);
		await mkdir(settingsPath);
		await expect(host.setModel(selected.provider, selected.id)).rejects.toThrow("settings could not be saved");
	} finally {
		await host?.dispose();
		probe.mockRestore();
		await rm(root, { recursive: true, force: true });
	}
});


it.each(["prompt", "steer", "followUp"] as const)("passes image content through %s and rejects text-only models", async (method) => {
	const { EmbeddedPiHost } = await import("./pi-runtime.js");
	const session = {
		model: { input: ["text", "image"] }, isStreaming: false,
		getActiveToolNames: () => [], setActiveToolsByName: vi.fn(),
		prompt: vi.fn(async () => {}), steer: vi.fn(async () => {}), followUp: vi.fn(async () => {}),
	};
	const skills = { refresh: async () => {}, expandCommand: (text: string) => text };
	const host = Reflect.construct(EmbeddedPiHost, [{ session }, {}, {}, skills]) as import("./pi-runtime.js").EmbeddedPiHost;
	const images = [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] as const;
	await host[method]("", [...images]);
	expect(session[method]).toHaveBeenCalledWith("", method === "prompt" ? { source: "rpc", images } : images);
	session.model.input = ["text"];
	await expect(host[method]("Inspect", [...images])).rejects.toThrow("supports images");
	expect(session[method]).toHaveBeenCalledTimes(1);
});

it("acknowledges prompt preflight before generation completes and does not acknowledge failed preflight", async () => {
	const { EmbeddedPiHost } = await import("./pi-runtime.js");
	let finish!: () => void;
	const generation = new Promise<void>((resolve) => { finish = resolve; });
	let preflight!: (success: boolean) => void;
	const session = {
		model: { input: ["text", "image"] }, isStreaming: false,
		getActiveToolNames: () => [], setActiveToolsByName: vi.fn(),
		prompt: vi.fn(async (_text, options) => { preflight = options.preflightResult; await generation; }),
	};
	const skills = { refresh: async () => {}, expandCommand: (text: string) => text };
	const host = Reflect.construct(EmbeddedPiHost, [{ session }, {}, {}, skills]) as import("./pi-runtime.js").EmbeddedPiHost;
	const accepted = vi.fn();
	const turn = host.prompt("Inspect", undefined, accepted);
	await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
	preflight(false);
	expect(accepted).not.toHaveBeenCalled();
	preflight(true);
	expect(accepted).toHaveBeenCalledOnce();
	finish();
	await turn;
});
