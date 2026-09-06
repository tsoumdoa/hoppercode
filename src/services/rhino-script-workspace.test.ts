import { afterEach, describe, expect, it } from "vitest";
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { RhinoScriptWorkspace } from "./rhino-script-workspace.js";
import { applySourcePatches, sourceLines } from "./source-line-patches.js";
import { resolveHostConfig } from "../host/config.js";
const dirs: string[] = [];
function workspace(quota?: number) {
	const dir = mkdtempSync(join(tmpdir(), "hopper-scripts-"));
	dirs.push(dir);
	return new RhinoScriptWorkspace(dir, quota);
}
const create = (w: RhinoScriptWorkspace, source = "a\nb\nc\n", id = "create") =>
	w.mutate({ action: "create", name: "test", language: "python", source }, id);
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
describe("original revision source patches", () => {
	it("preserves Unicode, LF normalization, final newline and empty source semantics", () => {
		expect(sourceLines("")).toEqual([]);
		expect(sourceLines("a\n")).toEqual(["a"]);
		expect(sourceLines("\n")).toEqual([""]);
		expect(
			applySourcePatches("a\nβ\nc\n", [
				{ action: "replace", startLine: 2, endLine: 2, lines: ["日本"] },
				{ action: "insert", afterLine: 3, lines: ["d"] },
			]),
		).toBe("a\n日本\nc\nd\n");
		expect(
			applySourcePatches("", [
				{ action: "insert", afterLine: 0, lines: ["hi"] },
			]),
		).toBe("hi");
		expect(
			applySourcePatches("a\n", [
				{ action: "delete", startLine: 1, endLine: 1 },
			]),
		).toBe("");
	});
	it("rejects overlap, embedded newlines, fractional/out-of-bounds lines and stale text", () => {
		expect(() =>
			applySourcePatches("a\nb", [
				{ action: "replace", startLine: 1, endLine: 2, lines: [] },
				{ action: "insert", afterLine: 1, lines: ["x"] },
			]),
		).toThrow("OVERLAPPING_PATCHES");
		expect(() =>
			applySourcePatches("a", [
				{ action: "insert", afterLine: 0, lines: ["x\ny"] },
			]),
		).toThrow("INVALID_PATCH");
		expect(() =>
			applySourcePatches("a", [
				{ action: "insert", afterLine: 0.5, lines: [] },
			]),
		).toThrow("INVALID_INPUT");
		expect(() =>
			applySourcePatches("a", [
				{
					action: "replace",
					startLine: 1,
					endLine: 1,
					lines: [],
					expectedText: "z",
				},
			]),
		).toThrow("TEXT_CONFLICT");
	});
});
describe("persistent source workspace", () => {
	it("creates, patches and reads a 100-line script by revision", () => {
		const w = workspace(),
			source =
				Array.from({ length: 100 }, (_, i) => `print(${i})`).join("\r\n") +
				"\r\n",
			r = create(w, source);
		const changed = w.mutate(
			{
				action: "patch",
				scriptId: r.scriptId,
				expectedRevision: 1,
				patches: [
					{
						action: "replace",
						startLine: 50,
						endLine: 50,
						lines: ["print('changed')"],
					},
				],
			},
			"edit",
		);
		expect(changed.revision).toBe(2);
		expect(changed.diff.text).toContain("+print('changed')");
		expect(w.get(r.scriptId, 2, 49, 51).lines.map((l) => l.text)).toEqual([
			"print(48)",
			"print('changed')",
			"print(50)",
		]);
		expect(w.resolve(r.scriptId, 1).source).toContain("print(49)");
	});
	it("keeps mutation results across later metadata/source changes and restart", () => {
		const w = workspace(),
			r = create(w);
		const patch = {
			action: "patch" as const,
			scriptId: r.scriptId,
			expectedRevision: 1,
			patches: [
				{ action: "replace" as const, startLine: 2, endLine: 2, lines: ["z"] },
			],
		};
		const old = w.mutate(patch, "patch");
		w.mutate(
			{
				action: "rename",
				scriptId: r.scriptId,
				expectedRevision: 2,
				name: "new",
			},
			"rename",
		);
		expect(w.mutate(patch, "patch")).toEqual(old);
		expect(create(w)).toEqual(r);
		expect(() => w.mutate({ ...patch, patches: [] }, "patch")).toThrow(
			"MUTATION_ID_CONFLICT",
		);
		expect(() => w.mutate(patch, "fresh")).toThrow("REVISION_CONFLICT");
		const restarted = new RhinoScriptWorkspace(
			join(w.store.directory, "../.."),
		);
		expect(restarted.resolve(r.scriptId).revision).toBe(3);
	});
	it("detects mutation ID reuse across assets, preserves no-ops, restores source and soft deletion", () => {
		const w = workspace(),
			r = create(w),
			other = create(w, "other", "other");
		expect(
			w.mutate(
				{
					action: "patch",
					scriptId: r.scriptId,
					expectedRevision: 1,
					patches: [],
				},
				"noop",
			).changed,
		).toBe(false);
		expect(() =>
			w.mutate(
				{
					action: "patch",
					scriptId: other.scriptId,
					expectedRevision: 1,
					patches: [],
				},
				"noop",
			),
		).toThrow("MUTATION_ID_CONFLICT");
		w.mutate(
			{
				action: "setSource",
				scriptId: r.scriptId,
				expectedRevision: 1,
				source: "new",
			},
			"edit",
		);
		w.mutate(
			{
				action: "restore",
				scriptId: r.scriptId,
				expectedRevision: 2,
				fromRevision: 1,
			},
			"restore",
		);
		expect(w.resolve(r.scriptId).source).toBe("a\nb\nc\n");
		w.mutate(
			{ action: "delete", scriptId: r.scriptId, expectedRevision: 3 },
			"delete",
		);
		expect(() => w.resolve(r.scriptId, 1, true)).toThrow("SCRIPT_DELETED");
		expect(w.history(r.scriptId).revisions).toHaveLength(4);
		expect(w.list().items).toHaveLength(1);
		w.mutate(
			{ action: "undelete", scriptId: r.scriptId, expectedRevision: 4 },
			"undelete",
		);
		expect(w.resolve(r.scriptId, 1, true).revision).toBe(1);
	});
	it("rejects a whole invalid patch with no partial persisted change", () => {
		const w = workspace(),
			r = create(w),
			before = readFileSync(
				join(w.store.directory, r.scriptId + ".json"),
				"utf8",
			);
		expect(() =>
			w.mutate(
				{
					action: "patch",
					scriptId: r.scriptId,
					expectedRevision: 1,
					patches: [
						{ action: "replace", startLine: 1, endLine: 1, lines: ["new"] },
						{ action: "delete", startLine: 99, endLine: 99 },
					],
				},
				"bad",
			),
		).toThrow();
		expect(
			readFileSync(join(w.store.directory, r.scriptId + ".json"), "utf8"),
		).toBe(before);
	});
	it("rejects foreign IDs and traversal, bounds reads and diffs", () => {
		const w = workspace(),
			other = workspace(),
			r = create(w, "x".repeat(20_000));
		expect(() => other.get(r.scriptId)).toThrow("WORKSPACE_MISMATCH");
		expect(() => w.get("../../etc/passwd")).toThrow("INVALID_ID");
		expect(w.get(r.scriptId).partialLine?.text).toHaveLength(16_000);
		expect(w.get(r.scriptId).truncated).toBe(true);
		expect(w.get(r.scriptId).partialLine?.nextCharacterOffset).toBe(16000);
		expect(w.get(r.scriptId, 1, 1, 1, 16000).partialLine?.text).toHaveLength(
			4000,
		);
		const changed = w.mutate(
			{
				action: "setSource",
				scriptId: r.scriptId,
				expectedRevision: 1,
				source: "y".repeat(20_000),
			},
			"edit",
		);
		expect(changed.diff.truncated).toBe(true);
	});
	it("refuses writes under quota or a live writer while permitting reads", () => {
		const w = workspace(),
			r = create(w);
		writeFileSync(
			join(w.store.directory, "writer.lock"),
			JSON.stringify({ pid: process.pid, hostname: hostname(), claim: "live" }),
		);
		expect(w.get(r.scriptId).revision).toBe(1);
		expect(() =>
			w.mutate(
				{
					action: "rename",
					scriptId: r.scriptId,
					expectedRevision: 1,
					name: "new",
				},
				"rename",
			),
		).toThrow("WORKSPACE_BUSY");
		const small = workspace(100);
		expect(() => create(small)).toThrow("WORKSPACE_LIMIT_REACHED");
		expect(small.list().items).toHaveLength(0);
	});
	it("recovers a lock only after the writer process is proven dead and retains corrupt records", () => {
		const w = workspace(),
			r = create(w);
		const child = spawnSync(process.execPath, [
			"-e",
			"process.stdout.write(String(process.pid))",
		]);
		const pid = Number(child.stdout.toString());
		writeFileSync(
			join(w.store.directory, "writer.lock"),
			JSON.stringify({ pid, hostname: hostname(), claim: "dead" }),
		);
		expect(
			w.mutate(
				{
					action: "rename",
					scriptId: r.scriptId,
					expectedRevision: 1,
					name: "recovered",
				},
				"rename",
			).revision,
		).toBe(2);
		const path = join(w.store.directory, r.scriptId + ".json");
		writeFileSync(path, "{broken");
		expect(() => w.get(r.scriptId)).toThrow("WORKSPACE_CORRUPT");
		expect(readFileSync(path, "utf8")).toBe("{broken");
		expect(readdirSync(w.store.directory).some((n) => n.endsWith(".tmp"))).toBe(
			false,
		);
	});
	it("keeps scripts stable when host lifecycle IDs change and supports workspace/quota overrides", () => {
		const w = workspace(),
			dataDir = join(w.store.directory, "../..");
		const a = resolveHostConfig(
				["--data-dir", dataDir, "--instance-id", "first"],
				{ env: {} },
			),
			b = resolveHostConfig(
				["--data-dir", dataDir, "--instance-id", "second"],
				{ env: {} },
			);
		expect(a.paths.workspaceDir).not.toBe(b.paths.workspaceDir);
		expect(a.paths.scriptWorkspaceDir).toBe(b.paths.scriptWorkspaceDir);
		const first = new RhinoScriptWorkspace(a.paths.scriptWorkspaceDir!),
			r = create(first),
			second = new RhinoScriptWorkspace(b.paths.scriptWorkspaceDir!);
		expect(second.get(r.scriptId).revision).toBe(1);
		expect(
			resolveHostConfig(["--script-workspace", dataDir], {
				env: { HOPPER_SCRIPT_WORKSPACE_QUOTA_BYTES: "100000" },
			}).paths.scriptWorkspaceQuotaBytes,
		).toBe(100000);
		expect(() =>
			resolveHostConfig(["--script-workspace", "relative"], { env: {} }),
		).toThrow("absolute");
	});
	it("serializes independent process writers without losing source revisions", async () => {
		const w = workspace(),
			asset = create(w),
			root = join(w.store.directory, "../..");
		const code = `import { RhinoScriptWorkspace } from './src/services/rhino-script-workspace.ts';
   const [root,id,name]=process.argv.slice(1); const w=new RhinoScriptWorkspace(root);
   try { const result=w.mutate({action:'rename',scriptId:id,expectedRevision:1,name},name); process.stdout.write(JSON.stringify({revision:result.revision})); }
   catch(error) { process.stdout.write(JSON.stringify({error:String(error)})); }`;
		const child = (name: string) =>
			new Promise<string>((resolve, reject) => {
				const p = spawn(process.execPath, [
					"--import",
					"tsx",
					"--input-type=module",
					"-e",
					code,
					root,
					asset.scriptId,
					name,
				]);
				let out = "",
					err = "";
				p.stdout.on("data", (b) => (out += b));
				p.stderr.on("data", (b) => (err += b));
				p.on("error", reject);
				p.on("exit", (status) =>
					status === 0 ? resolve(out) : reject(new Error(err)),
				);
			});
		const results = (await Promise.all([child("first"), child("second")])).map(
			(s) => JSON.parse(s),
		);
		expect(results.filter((r) => r.revision === 2)).toHaveLength(1);
		expect(results.find((r) => r.error).error).toMatch(
			/WORKSPACE_BUSY|REVISION_CONFLICT/,
		);
		expect(w.resolve(asset.scriptId).revision).toBe(2);
	});
});
