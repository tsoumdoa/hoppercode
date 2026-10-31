import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	it("does not allow a user folder to re-expose disabled bundled files", async () => {
		const { project, library } = await fixture();
		const skill = library.snapshot().skills[0];
		await library.update({ type: "toggle", id: skill.id, enabled: false });
		await library.update({ type: "folder", folder: project });
		expect(library.snapshot().skills).toHaveLength(2);
		expect(() => library.read(skill.path)).toThrow("disabled");
		expect(library.snapshot().diagnostics).toContain("Choose a Markdown folder separate from the bundled skills and references.");
	});
});
