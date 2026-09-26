import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { ToolPolicyRuntime } from "../services/tool-policy-runtime.js";
import { HostSkillLibrary } from "./skills.js";
import { EmbeddedPiHost, isolatedResourceLoaderOptions } from "./pi-runtime.js";

vi.mock("../infra/backend-status.js", () => ({
	probeBackend: vi.fn(async () => ({ online: true })),
	getCachedBackendStatus: vi.fn(() => ({ online: true })),
	refreshBackendIfOffline: vi.fn(async () => true),
}));
vi.mock("../ui/backend-status.js", () => ({ registerBackendStatusUI: vi.fn() }));
vi.mock("../ui/tool-schemas.js", () => ({ registerToolSchemasUI: vi.fn() }));

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(projectRoot?: string) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "hopper-skills-")));
	directories.push(root);
	const project = projectRoot ?? join(root, "project");
	if (!projectRoot) {
		await mkdir(join(project, "mds", "skills", "modeling", "reference"), { recursive: true });
		await mkdir(join(project, "mds", "reference"), { recursive: true });
		await writeFile(join(project, "mds", "skills", "modeling", "SKILL.md"), "---\nname: modeling\ndescription: Build models\n---\n# Modeling\nRead reference/example.md");
		await writeFile(join(project, "mds", "skills", "modeling", "reference", "example.md"), "# Example\nCreate a sphere.");
		await writeFile(join(project, "mds", "reference", "SKILL.md"), "---\nname: reference\ndescription: Shared docs\n---\n# Reference");
	}
	const folder = join(root, "markdown");
	const preferences = join(root, "settings", "skills.json");
	const library = new HostSkillLibrary(project, preferences, folder);
	await library.initialize();
	return { root, project, folder, preferences, library };
}

describe("host skill library", () => {
	it.each(["prompt", "steer", "followUp"] as const)("expands %s skill commands from cached bytes even after a symlink replacement", async (method) => {
		const { root, folder, library } = await fixture();
		const path = join(folder, "rules.md");
		await writeFile(path, "---\nname: rules\ndisable-model-invocation: true\n---\n# Approved rules");
		await library.refresh();
		const outside = join(root, "outside.txt");
		await writeFile(outside, "Outside library secret");
		const replace = async () => { await rm(path); await symlink(outside, path); };
		const policy = new ToolPolicyRuntime({ directory: join(root, "tool-settings"), embedded: true });
		const services = await createAgentSessionServices({
			cwd: root, agentDir: join(root, "agent"), resourceLoaderOptions: isolatedResourceLoaderOptions({ toolPolicy: policy, scriptWorkspaceDir: join(root, "scripts") }),
		});
		services.resourceLoader.getSkills = () => policy.isToolExposed("read") ? library.getSkills() : { skills: [], diagnostics: [] };
		const { session } = await createAgentSessionFromServices({
			services, sessionManager: SessionManager.inMemory(root), noTools: "builtin", customTools: [policy.customTool(library.createReadTool(root))],
		});
		try {
			await session.bindExtensions({ mode: "rpc", uiContext: { notify: vi.fn() } as never });
			// Exercise Pi's real command expansion without making a model request.
			vi.spyOn(session, "model", "get").mockReturnValue({} as NonNullable<typeof session.model>);
			vi.spyOn(session, "prompt").mockImplementation((text) => session.followUp(text));
			if (method === "prompt") {
				const refresh = library.refresh.bind(library);
				vi.spyOn(library, "refresh").mockImplementation(async () => { await refresh(); await replace(); });
			} else { await replace(); }
			const host = Reflect.construct(EmbeddedPiHost, [{ session }, {}, {}, library]) as EmbeddedPiHost;
			await host[method]("/skill:rules Build a sphere");
			const queued = method === "steer" ? session.getSteeringMessages() : session.getFollowUpMessages();
			expect(queued).toHaveLength(1);
			expect(queued[0]).toContain("# Approved rules");
			expect(queued[0]).toContain(`References are relative to ${folder}.`);
			expect(queued[0]).toMatch(/<\/skill>\n\nBuild a sphere$/);
			expect(queued[0]).not.toContain("disable-model-invocation");
			expect(queued[0]).not.toContain("Outside library secret");
		} finally { await policy.close(); session.dispose(); vi.restoreAllMocks(); }
	});

	it("leaves unknown and disabled skill commands unexpanded", async () => {
		const { library } = await fixture();
		const skill = library.snapshot().skills[0];
		expect(library.expandCommand(`/skill:${skill.name}`)).toContain("# Modeling");
		await library.update({ type: "toggle", id: skill.id, enabled: false });
		for (const text of [`/skill:${skill.name}`, "/skill:missing args", "Create a sphere"]) {
			expect(library.expandCommand(text)).toBe(text);
		}
	});

	it("does not re-enable references when a disabled package's SKILL.md cannot load", async () => {
		const { library } = await fixture();
		const skill = library.snapshot().skills[0];
		const reference = skill.files.find((path) => path.endsWith("example.md"))!;
		await library.update({ type: "toggle", id: skill.id, enabled: false });
		await writeFile(skill.path, "x".repeat(256 * 1024 + 1));
		await library.refresh();
		expect(library.snapshot().skills.map((entry) => entry.name)).toEqual(["reference"]);
		expect(() => library.read(reference)).toThrow("unavailable or disabled");
	});

	it("starts with bundled skills when a saved custom folder is unavailable", async () => {
		const { root, project, folder, preferences, library } = await fixture();
		const custom = join(root, "external-folder");
		await mkdir(custom);
		await library.update({ type: "folder", folder: custom });
		await rm(custom, { recursive: true });
		// Simulate a disconnected location that can no longer be created as a directory.
		await writeFile(custom, "not a directory");
		const restored = new HostSkillLibrary(project, preferences, folder);
		await restored.initialize();
		expect(restored.getSkills().skills.map((skill) => skill.name)).toEqual(["modeling", "reference"]);
		expect(restored.snapshot().diagnostics.join("\n")).toContain(custom);
		await restored.update({ type: "folder", folder });
		expect(restored.snapshot().diagnostics).toEqual([]);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("keeps discovering other skills when one Markdown file cannot be read", async () => {
		const { folder, library } = await fixture();
		const unreadable = join(folder, "a-unreadable.md");
		await writeFile(unreadable, "Unreadable");
		await writeFile(join(folder, "z-valid.md"), "Valid instructions");
		await chmod(unreadable, 0);
		try {
			await library.refresh();
			expect(library.snapshot().skills.some((skill) => skill.name === "z-valid")).toBe(true);
			expect(library.snapshot().diagnostics.join("\n")).toContain(unreadable);
		} finally { await chmod(unreadable, 0o600); }
	});

	it("discovers loose Markdown, packages references, and refreshes edits and removals", async () => {
		const { folder, library } = await fixture();
		await writeFile(join(folder, "office.md"), "# Office modeling rules\nAlways use meters.");
		await mkdir(join(folder, "facades", "reference"), { recursive: true });
		await writeFile(join(folder, "facades", "SKILL.md"), "---\nname: facade-design\ndescription: Design facades\n---\n# Facades");
		await writeFile(join(folder, "facades", "reference", "panels.md"), "# Panel rules");
		await library.refresh();
		expect(library.snapshot().skills.map((skill) => skill.name)).toEqual(["modeling", "reference", "facade-design", "office"]);
		const facade = library.snapshot().skills.find((skill) => skill.name === "facade-design")!;
		expect(facade.files).toHaveLength(2);
		expect(library.getSkills().skills.find((skill) => skill.name === "office")?.description).toBe("Office modeling rules");
		await writeFile(join(folder, "office.md"), "# Updated office rules");
		await library.refresh();
		expect(library.read(join(folder, "office.md"))).toContain("Updated office rules");
		await rm(join(folder, "office.md"));
		await library.refresh();
		expect(() => library.read(join(folder, "office.md"))).toThrow("unavailable or disabled");
	});

	it("persists disable state and blocks the skill and its references while allowing UI previews", async () => {
		const { project, folder, preferences, library } = await fixture();
		const modeling = library.snapshot().skills[0];
		const reference = modeling.files.find((path) => path.endsWith("example.md"))!;
		library.read(reference);
		await library.update({ type: "toggle", id: modeling.id, enabled: false });
		expect(library.getSkills().skills.map((skill) => skill.name)).toEqual(["reference"]);
		expect(() => library.read(modeling.path)).toThrow("disabled");
		expect(() => library.read(reference)).toThrow("disabled");
		expect(library.read(modeling.path, false)).toContain("# Modeling");
		const restored = new HostSkillLibrary(project, preferences, folder);
		await restored.initialize();
		expect(restored.snapshot().skills[0].enabled).toBe(false);
		await restored.update({ type: "toggle", id: modeling.id, enabled: true });
		expect(restored.read(reference)).toContain("Create a sphere");
	});

	it("rejects outside files, sibling-prefix paths, non-Markdown, and symlinks", async () => {
		const { root, folder, library } = await fixture();
		const outside = join(root, "secret.md");
		await writeFile(outside, "do not expose");
		await writeFile(join(folder, "code.js"), "code");
		await symlink(outside, join(folder, "linked.md"));
		await mkdir(join(root, "markdown-other"));
		await writeFile(join(root, "markdown-other", "secret.md"), "other");
		await symlink(join(root, "markdown-other"), join(folder, "linked-folder"));
		await library.refresh();
		for (const path of [outside, join(folder, "..", "secret.md"), join(folder, "linked.md"), join(folder, "linked-folder", "secret.md"), join(root, "markdown-other", "secret.md"), join(folder, "code.js")]) {
			expect(() => library.read(path)).toThrow("unavailable or disabled");
		}
		expect(library.snapshot().diagnostics.join("\n")).toContain("Skipped symbolic link");
	});

	it("serves approved bytes if a file is replaced with a symlink after discovery", async () => {
		const { root, folder, library } = await fixture();
		const path = join(folder, "rules.md");
		await writeFile(path, "Approved rules");
		await writeFile(join(root, "secret.md"), "Secret");
		await library.refresh();
		await rm(path);
		await symlink(join(root, "secret.md"), path);
		expect(library.read(path)).toBe("Approved rules");
		await library.refresh();
		expect(() => library.read(path)).toThrow("unavailable or disabled");
	});

	it("switches the drop folder persistently and removes access to the old folder", async () => {
		const { root, project, folder, preferences, library } = await fixture();
		await writeFile(join(folder, "old.md"), "Old");
		const next = join(root, "another folder");
		await mkdir(next);
		await writeFile(join(next, "new.md"), "New rules");
		await library.update({ type: "folder", folder: next });
		expect(library.read(join(next, "new.md"))).toBe("New rules");
		expect(() => library.read(join(folder, "old.md"))).toThrow();
		const restored = new HostSkillLibrary(project, preferences, folder);
		await restored.initialize();
		expect(restored.snapshot().folder).toBe(next);
		await expect(library.update({ type: "folder", folder: "relative/path" })).rejects.toThrow("absolute");
	});

	it("does not allow a user folder to re-expose disabled bundled files", async () => {
		const { project, library } = await fixture();
		const skill = library.snapshot().skills[0];
		await library.update({ type: "toggle", id: skill.id, enabled: false });
		await library.update({ type: "folder", folder: project });
		expect(library.snapshot().skills).toHaveLength(2);
		expect(() => library.read(skill.path)).toThrow("disabled");
		expect(library.snapshot().diagnostics).toContain("Choose a Markdown folder separate from the bundled skills and references.");
	});

	it("advertises all four real bundled skills in Pi with only the restricted read and Hopper tools", async () => {
		const { root, library } = await fixture(resolve("."));
		const policy = new ToolPolicyRuntime({ directory: join(root, "tool-settings"), embedded: true });
		const services = await createAgentSessionServices({
			cwd: root, agentDir: join(root, "agent"),
			resourceLoaderOptions: isolatedResourceLoaderOptions({ toolPolicy: policy, scriptWorkspaceDir: join(root, "scripts") }),
		});
		services.resourceLoader.getSkills = () => policy.isToolExposed("read") ? library.getSkills() : { skills: [], diagnostics: [] };
		const { session } = await createAgentSessionFromServices({
			services, sessionManager: SessionManager.inMemory(root), noTools: "builtin", customTools: [policy.customTool(library.createReadTool(root))],
		});
		try {
			await session.bindExtensions({ mode: "rpc", uiContext: { notify: vi.fn() } as never });
			expect(session.getAllTools().map(tool => tool.name)).toEqual(expect.arrayContaining(policy.inventory.map(tool => tool.name)));
			const active = session.getActiveToolNames();
			expect(active.every(name => policy.inventory.some(tool => tool.name === name))).toBe(true);
			expect(active).toContain("read");
			expect(active).toContain("rh_run_script");
			expect(active).toContain("ask_user");
			for (const name of ["bash", "edit", "write", "grep", "find", "ls"]) expect(active).not.toContain(name);
			for (const name of ["rhino-document", "gh-modeling-expert", "gh-cookbook", "gh-reference"]) {
				expect(session.systemPrompt).toContain(`<name>${name}</name>`);
			}
			const skill = library.snapshot().skills.find((entry) => entry.name === "rhino-document")!;
			const read = session.agent.state.tools.find((tool) => tool.name === "read")!;
			const result = await read.execute("test-read", { path: skill.path });
			expect(JSON.stringify(result.content)).toContain("name: rhino-document");
			await expect(read.execute("test-outside", { path: join(root, "auth.json") })).rejects.toThrow("unavailable");
			await library.update({ type: "toggle", id: skill.id, enabled: false });
			session.setActiveToolsByName(active);
			expect(session.systemPrompt).not.toContain("<name>rhino-document</name>");
			await expect(read.execute("test-disabled", { path: skill.path })).rejects.toThrow("disabled");
		} finally {
			await policy.close();
			session.dispose();
		}
	});
});
