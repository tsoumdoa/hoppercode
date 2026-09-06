import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHopperPiExtension } from "../index.js";
import { createRhScriptTool, rhScriptParameters } from "./rh-script.js";
import { createRhRunScriptTool } from "./rh-run-script.js";
import { RhinoScriptWorkspace } from "../services/rhino-script-workspace.js";
import { RhinoScriptExecution } from "../services/rhino-script-execution.js";
import { rankHopperTools } from "./hopper-search-tools.js";
import { HOPPER_REGISTERED_CATALOG } from "./catalog.js";
vi.mock("../infra/backend-status.js", () => ({
	probeBackend: vi.fn(),
	refreshBackendIfOffline: vi.fn(async () => false),
}));
vi.mock("../ui/backend-status.js", () => ({
	registerBackendStatusUI: vi.fn(),
}));
vi.mock("../ui/tool-schemas.js", () => ({ registerToolSchemasUI: vi.fn() }));
vi.mock("../services/rhino-capture-model.js", () => ({
	createRhinoCaptureModelController: () => ({
		syncCaptureToolForModel: vi.fn(),
	}),
	promptWantsVisualCapture: vi.fn(),
	rhinoCaptureUnavailableGuidance: vi.fn(),
}));
const dirs: string[] = [];
function directory() {
	const dir = mkdtempSync(join(tmpdir(), "hopper-script-tools-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
it("registers rh_script without a backend guard and rebinds to persistent session identity", async () => {
	const registered = new Map<string, ToolDefinition>(),
		events = new Map<string, Function>();
	const pi = {
		registerFlag: vi.fn(),
		getFlag: () => false,
		registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool),
		on: (name: string, handler: Function) => events.set(name, handler),
	};
	const workspaceDir = directory();
	createHopperPiExtension({ scriptWorkspaceDir: workspaceDir })(pi as never);
	const context = (id: string) => ({
		cwd: directory(),
		sessionManager: { getSessionId: () => id },
		ui: { notify: vi.fn() },
	});
	events.get("session_start")!({ reason: "startup" }, context("session-one"));
	const tool = registered.get("rh_script")!;
	const request = {
		action: "create",
		name: "source",
		language: "python",
		source: "print(1)",
	};
	const first = await tool.execute(
		"same-call",
		request,
		undefined,
		undefined,
		{} as never,
	);
	expect(first).not.toHaveProperty("isError", true);
	events.get("session_start")!({ reason: "switch" }, context("session-two"));
	const second = await tool.execute(
		"same-call",
		request,
		undefined,
		undefined,
		{} as never,
	);
	expect((second.details as { scriptId: string }).scriptId).not.toBe(
		(first.details as { scriptId: string }).scriptId,
	);
	events.get("session_start")!({ reason: "switch" }, context("session-one"));
	expect(
		(
			await tool.execute(
				"same-call",
				request,
				undefined,
				undefined,
				{} as never,
			)
		).details,
	).toEqual(first.details);
	const run = await registered
		.get("rh_run_script")!
		.execute(
			"run",
			{ items: [{ mode: "python", source: "print(1)" }] },
			undefined,
			undefined,
			{} as never,
		);
	expect(JSON.stringify(run)).toContain("offline");
});
it("exports provider-compatible object schemas and strictly validates action-specific requirements", async () => {
	expect(rhScriptParameters).toHaveProperty("type", "object");
	expect(rhScriptParameters).not.toHaveProperty("anyOf");
	const workspace = new RhinoScriptWorkspace(directory()),
		execution = new RhinoScriptExecution(workspace, () => {
			throw new Error("offline");
		});
	const tool = createRhScriptTool(() => ({
		workspace,
		execution,
		sessionId: "session",
	}));
	const invalid = await tool.execute(
		"call",
		{ action: "create", name: "test", language: "python" } as never,
		undefined,
		undefined,
		{} as never,
	);
	expect(invalid).toHaveProperty("isError", true);
	expect(workspace.list().items).toHaveLength(0);
	const created = await tool.execute(
		"call",
		{ action: "create", name: "test", language: "python", source: "x" },
		undefined,
		undefined,
		{} as never,
	);
	expect(created).not.toHaveProperty("isError", true);
	const target = await tool.execute(
		"target",
		{ action: "getExecutionTarget" },
		undefined,
		undefined,
		{} as never,
	);
	expect(target).toHaveProperty("isError", true);
	const scriptId = (created.details as { scriptId: string }).scriptId;
	const ambiguous = await createRhRunScriptTool(() => ({
		workspace,
		execution,
		sessionId: "session",
	})).execute(
		"run",
		{
			items: [
				{
					scriptId,
					revision: 1,
					source: "x",
					expectedDocument: { documentId: "doc", lifecycleInstanceId: "host" },
				},
			],
		} as never,
		undefined,
		undefined,
		{} as never,
	);
	expect(ambiguous).toHaveProperty("isError", true);
	expect(JSON.stringify(ambiguous)).toContain("cannot supply source");
});
it("discovers saved source edits without confusing Grasshopper component editing", () => {
	const matches = rankHopperTools(
		HOPPER_REGISTERED_CATALOG,
		"saved script virtual edit revision",
	).matches;
	expect(matches.some((m) => m.name === "rh_script")).toBe(true);
	expect(
		HOPPER_REGISTERED_CATALOG.find((e) => e.tool.name === "rh_script")!
			.requires,
	).toBeUndefined();
});
