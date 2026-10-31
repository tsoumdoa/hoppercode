import { afterEach, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { releaseArchives, sha256, verifyReleaseArchive, versionFiles } from "./release-utils.mjs";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { force: true, recursive: true }); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "hopper-release-test-")); temporary.push(root);
	for (const file of versionFiles) {
		mkdirSync(join(root, file, ".."), { recursive: true });
		writeFileSync(join(root, file), file === "package.json" ? '{"version":"0.2.0"}\n' : '<Project><Version>0.2.0</Version></Project>\n');
	}
	return root;
}

it("rejects dirty, stale, or modified archives", () => {
	const root = fixture(); const archive = releaseArchives(root, "0.2.0")[0];
	mkdirSync(archive.folder, { recursive: true }); writeFileSync(archive.file, "binary");
	const record = { version: "0.2.0", target: archive.target, commit: "abc", dirty: false, sha256: sha256(archive.file) };
	writeFileSync(archive.provenance, JSON.stringify(record));
	expect(() => verifyReleaseArchive(archive, "0.2.0", "abc")).not.toThrow();
	expect(() => verifyReleaseArchive(archive, "0.2.0", "def")).toThrow();
	writeFileSync(archive.provenance, JSON.stringify({ ...record, dirty: true }));
	expect(() => verifyReleaseArchive(archive, "0.2.0", "abc")).toThrow();
	writeFileSync(archive.provenance, JSON.stringify(record)); writeFileSync(archive.file, "changed");
	expect(() => verifyReleaseArchive(archive, "0.2.0", "abc")).toThrow("archive changed");
});

function releaseFixture() {
	const root = fixture();
	mkdirSync(join(root, "scripts"));
	for (const file of ["release.mjs", "release-utils.mjs", "yak.mjs"]) cpSync(new URL(file, import.meta.url), join(root, "scripts", file));
	const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
	function git(args: string[]) {
		const result = spawnSync(realGit, args, { cwd: root, encoding: "utf8" });
		if (result.status) throw new Error(result.stderr);
		return result.stdout.trim();
	}
	writeFileSync(join(root, ".gitignore"), "artifacts/\nfake-bin/\ncalls.jsonl\n");
	git(["init", "-b", "main"]); git(["add", "."]);
	git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Release fixture"]);
	git(["remote", "add", "origin", "git@github.com:example/hopper.git"]);
	const commit = git(["rev-parse", "HEAD"]);
	for (const archive of releaseArchives(root, "0.2.0")) {
		mkdirSync(archive.folder, { recursive: true }); writeFileSync(archive.file, "archive");
		writeFileSync(archive.provenance, JSON.stringify({ version: "0.2.0", target: archive.target, commit, dirty: false, sha256: sha256(archive.file) }));
	}
	const bin = join(root, "fake-bin"); mkdirSync(bin);
	for (const name of ["git", "gh", "yak"]) writeFileSync(join(bin, name), `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const name = ${JSON.stringify(name)};
fs.appendFileSync('calls.jsonl', JSON.stringify([name, ...args]) + '\\n');
if (name === 'git' && !['push', 'ls-remote'].includes(args[0])) {
 const r = cp.spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'}); process.exit(r.status ?? 1);
}
if (name === 'yak' && args[0] === 'push' && process.env.FAIL_YAK) process.exit(7);
`, { mode: 0o755 });
	return { root, commit,
		run: (args: string[], fail = false) => spawnSync(process.execPath, ["scripts/release.mjs", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: bin + delimiter + process.env.PATH, HOPPER_YAK: join(bin, "yak"), FAIL_YAK: fail ? "1" : "" } }),
		calls: () => readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]),
	};
}

it.skipIf(process.platform === "win32")("creates the draft on the built commit, uploads Yak, then publishes GitHub", () => {
	const f = releaseFixture(); const result = f.run([]);
	expect(result.status, result.stderr).toBe(0);
	const calls = f.calls();
	const draft = calls.findIndex((args) => args[0] === "gh" && args[2] === "create");
	const upload = calls.findIndex((args) => args[0] === "yak" && args[1] === "push");
	const publish = calls.findIndex((args) => args[0] === "gh" && args[2] === "edit");
	expect(calls[draft]).toContain(f.commit);
	expect(calls[draft]).toContain("example/hopper");
	expect(draft).toBeLessThan(upload); expect(upload).toBeLessThan(publish);
});

it.skipIf(process.platform === "win32")("does not publish the GitHub draft after Yak fails", () => {
	const f = releaseFixture(); expect(f.run([], true).status).toBe(1);
	expect(f.calls().some((args) => args[0] === "gh" && args[2] === "edit")).toBe(false);
});

it.skipIf(process.platform === "win32")("dry-run performs no remote mutations", () => {
	const f = releaseFixture(); const result = f.run(["--dry-run"]);
	expect(result.status, result.stderr).toBe(0);
	expect(f.calls().some((args) => args[0] === "yak" || args[1] === "push" || args[2] === "create" || args[2] === "edit")).toBe(false);
	expect(result.stdout).toContain('"--target"');
});
