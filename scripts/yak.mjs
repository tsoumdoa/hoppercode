#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { releaseArchives } from "./release-utils.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const sources = { test: "https://test.yak.rhino3d.com", public: "https://yak.rhino3d.com" };

try {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2).filter((arg) => arg !== "--"),
		allowPositionals: true,
		options: { "dry-run": { type: "boolean" }, output: { type: "string" }, help: { type: "boolean", short: "h" } },
	});
	if (values.help || positionals.length === 0) {
		console.log(`Usage: pnpm yak <command> <source> [--dry-run] [--output <dir>]

  install local       Install the existing build for this machine; quit Rhino first
  install test        Install this version from the test server
  install public      Install this version from the public server
  push test           Log in and upload both builds to the test server
  push public         Log in and publish both builds publicly
  search test|public  List published versions

Defaults to artifacts/hoppercode-${version}-<target>.
Use --output with the same directory used by pnpm build --output.
Local install also accepts the direct output of pnpm build --target <name> --output <dir>.
--dry-run prints commands without running Yak. It still checks local files.
Set HOPPER_YAK to an absolute executable path for a custom Rhino installation.`);
		process.exit(0);
	}
	const [command, source] = positionals;
	if (positionals.length !== 2 || !["install", "push", "search"].includes(command)
		|| !(Object.hasOwn(sources, source) || (command === "install" && source === "local"))) {
		throw new Error("Use pnpm yak --help for supported commands and sources.");
	}
	const yak = process.env.HOPPER_YAK || (process.platform === "darwin"
		? "/Applications/Rhino 8.app/Contents/Resources/bin/yak"
		: join(process.env.ProgramFiles || "C:\\Program Files", "Rhino 8", "System", "Yak.exe"));
	if (!isAbsolute(yak) || !existsSync(yak)) throw new Error("Yak not found. Set HOPPER_YAK to its absolute executable path.");
	function run(args) {
		console.log([yak, ...args].map((arg) => JSON.stringify(arg)).join(" "));
		if (values["dry-run"]) return;
		const result = spawnSync(yak, args, { stdio: "inherit", cwd: root });
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`Yak failed with exit code ${result.status ?? "unknown"}. Stopping; earlier successful uploads remain on the server.`);
	}
	function archive(target, allowDirectOutput = false) {
		let { folder, file } = releaseArchives(root, version, values.output).find((archive) => archive.target === target);
		if (allowDirectOutput && values.output && !existsSync(file)) {
			file = resolve(root, values.output, basename(file));
			folder = resolve(root, values.output);
		}
		if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size === 0) throw new Error(`Missing or empty package: ${file}. Run pnpm build first.`);
		return { folder, file };
	}
	const sourceArgs = source === "local" ? [] : ["--source", sources[source]];
	if (command === "push") {
		// Resolve both before login or the first upload, so a missing build cannot cause a partial release.
		const packages = [archive("mac-arm64"), archive("win-x64")];
		run(["login", ...sourceArgs]);
		for (const { file } of packages) run(["push", ...sourceArgs, file]);
		run(["search", ...sourceArgs, "--all", "--prerelease", "hoppercode"]);
	} else if (command === "install") {
		if (source === "local") {
			const target = process.platform === "darwin" && process.arch === "arm64" ? "mac-arm64"
				: process.platform === "win32" && process.arch === "x64" ? "win-x64" : null;
			if (!target) throw new Error("Local installation supports macOS arm64 and Windows x64 only.");
			run(["install", "--source", archive(target, true).folder, "hoppercode", version]);
		} else run(["install", ...sourceArgs, "hoppercode", version]);
		console.log("Restart Rhino, run HopperCode, and test provider sign-in, a Rhino operation, and a Grasshopper operation.");
	} else run(["search", ...sourceArgs, "--all", "--prerelease", "hoppercode"]);
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
