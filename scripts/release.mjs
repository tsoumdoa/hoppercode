#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { releaseArchives, verifyReleaseArchive, versionFiles } from "./release-utils.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

try {
	const { values } = parseArgs({ args: process.argv.slice(2).filter((arg) => arg !== "--"), options: {
		"dry-run": { type: "boolean" }, "github-only": { type: "boolean" }, output: { type: "string" }, help: { type: "boolean", short: "h" },
	} });
	if (values.help) {
		console.log(`Usage: pnpm release [--dry-run] [--github-only] [--output <dir>]

Publishes the current version to Yak and GitHub using the existing tested builds.
Requires a clean committed checkout, build provenance, gh login, and origin on GitHub.
Pushes the current branch to origin and creates a v<version> tag on that exact commit.
Creates a GitHub draft with both archives, uploads to Yak, then publishes the draft.
--github-only skips Yak when those exact distributions are already published.
--dry-run validates local state and prints mutations without executing them.
If interrupted, see docs/releasing.md before retrying.`);
		process.exit(0);
	}
	function read(command, args) {
		const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
		return result.stdout.trim();
	}
	function run(command, args) {
		console.log([command, ...args].map((arg) => JSON.stringify(arg)).join(" "));
		if (values["dry-run"]) return;
		const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`${command} failed. Earlier pushes/uploads remain. See docs/releasing.md for recovery.`);
	}
	const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("This command supports stable releases only.");
	for (const file of versionFiles.slice(1)) {
		if (readFileSync(join(root, file), "utf8").match(/<Version>([^<]+)<\/Version>/)?.[1] !== version) throw new Error(`Version mismatch in ${file}.`);
	}
	if (read("git", ["status", "--porcelain"])) throw new Error("Commit your changes first, then build and test from that clean commit.");
	const commit = read("git", ["rev-parse", "HEAD"]);
	const branch = read("git", ["symbolic-ref", "--short", "HEAD"]);
	const remote = read("git", ["remote", "get-url", "origin"]);
	const match = remote.match(/^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/);
	if (!match) throw new Error("origin must be a github.com SSH or HTTPS repository URL.");
	const repo = match[1];
	const tag = `v${version}`;
	const archives = releaseArchives(root, version, values.output);
	for (const archive of archives) {
		if (!existsSync(archive.provenance)) throw new Error(`Missing build record: ${archive.provenance}. Rebuild from the clean release commit.`);
		verifyReleaseArchive(archive, version, commit);
	}
	// Validate the Yak executable and both file paths without logging in or uploading.
	if (!values["github-only"]) read(process.execPath, [join(root, "scripts/yak.mjs"), "push", "public", "--dry-run", ...(values.output ? ["--output", values.output] : [])]);
	read("gh", ["auth", "status"]);
	if (read("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`])) throw new Error(`${tag} already exists on GitHub. See the recovery instructions; do not overwrite the tag.`);
	// gh creates the tag at this full SHA, never implicitly at the default branch.
	run("git", ["push", "origin", `HEAD:refs/heads/${branch}`]);
	run("gh", ["release", "create", tag, ...archives.map((archive) => archive.file), "--repo", repo, "--target", commit,
		"--title", `HopperCode ${version}`, "--generate-notes", "--draft"]);
	if (!values["github-only"]) run(process.execPath, [join(root, "scripts/yak.mjs"), "push", "public", ...(values.output ? ["--output", values.output] : [])]);
	run("gh", ["release", "edit", tag, "--repo", repo, "--draft=false", "--latest"]);
	console.log(`${values["dry-run"] ? "Would publish" : "Published"} https://github.com/${repo}/releases/tag/${tag}`);
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
