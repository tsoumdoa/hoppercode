import { link, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DEPENDENCY_PRUNE_RULES } from "./rhino-dependency-pruning.mjs";
import { deduplicatePiBundle, pruneAuditedDependencies } from "./prune-rhino-host.mjs";
import { evaluatePackagePath } from "./rhino-package-rules.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "hopper-prune-"));
	roots.push(root);
	for (const rule of DEPENDENCY_PRUNE_RULES) {
		const packageRoot = join(root, rule.name);
		await mkdir(packageRoot, { recursive: true });
		await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version: rule.version }));
		for (const path of rule.paths) {
			const file = join(packageRoot, path === "src" ? "src/index.ts" : path);
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, "development");
		}
	}
	await writeFile(join(root, "cmake-ts/build/loader.js"), "runtime");
	return root;
}

it("rejects an unaudited version before removing any package's files", async () => {
	const root = await fixture();
	await writeFile(join(root, "cmake-ts/package.json"), '{"version":"2.0.0"}');
	await expect(pruneAuditedDependencies(root)).rejects.toThrow("Review dependency pruning");
	expect(await readFile(join(root, "openai/src/index.ts"), "utf8")).toBe("development");
});

it("rejects changed layouts before removing any package's files", async () => {
	const root = await fixture();
	await rm(join(root, "cmake-ts/build/main.js"));
	await expect(pruneAuditedDependencies(root)).rejects.toThrow();
	expect(await readFile(join(root, "openai/src/index.ts"), "utf8")).toBe("development");
});

it("preserves the native loader and denies audited paths in either stage", async () => {
	const root = await fixture();
	await pruneAuditedDependencies(root);
	expect(await readFile(join(root, "cmake-ts/build/loader.js"), "utf8")).toBe("runtime");
	for (const target of ["mac-arm64", "win-x64"]) {
		for (const rule of DEPENDENCY_PRUNE_RULES) {
			for (const path of rule.paths) expect(evaluatePackagePath(`runtime/host/node_modules/${rule.name}/${path}`, target).allowed).toBe(false);
		}
		for (const path of ["cmake-ts/build/loader.js", "cmake-ts/build/loader.mjs", "openai/index.js", "openai/index.mjs", "zod/v4/core/index.cjs", "unreviewed/src/runtime.js"]) {
			expect(evaluatePackagePath(`runtime/host/node_modules/${path}`, target).allowed).toBe(true);
		}
	}
});

async function linkedPiFixture(version = "0.87.1") {
	const root = await mkdtemp(join(tmpdir(), "hopper-prune-links-"));
	roots.push(root);
	const nodeModules = join(root, "node_modules");
	const packageRoot = join(nodeModules, "@earendil-works/pi-coding-agent");
	const bundle = join(packageRoot, "dist/bundle");
	await mkdir(join(bundle, "chunks"), { recursive: true });
	await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version }));
	for (const name of ["cli-runtime.js", "cli.js", "index.js", "rpc-entry.js"]) {
		await writeFile(join(packageRoot, "dist", name), "original SDK");
		await writeFile(join(root, name), `original shared ${name}`);
		if (name === "cli-runtime.js") await writeFile(join(bundle, name), "bundled cli runtime");
		else await link(join(root, name), join(bundle, name));
	}
	return { root, nodeModules, bundle };
}

it("replaces staged Pi entries without modifying their hardlinked store originals", async () => {
	const { root, nodeModules, bundle } = await linkedPiFixture();
	await deduplicatePiBundle(nodeModules);
	for (const name of ["cli.js", "index.js", "rpc-entry.js"]) {
		expect(await readFile(join(root, name), "utf8")).toBe(`original shared ${name}`);
		expect(await readFile(join(bundle, name), "utf8")).toBe(name === "index.js"
			? 'export * from "../index.js";\n'
			: `#!/usr/bin/env node\nimport "../${name}";\n`);
	}
	await expect(readFile(join(bundle, "cli-runtime.js"), "utf8")).rejects.toThrow();
});

it("checks the Pi version before replacing any hardlinked entries", async () => {
	const { root, nodeModules, bundle } = await linkedPiFixture("0.86.0");
	await expect(deduplicatePiBundle(nodeModules)).rejects.toThrow("Review Pi bundle deduplication");
	for (const name of ["cli-runtime.js", "cli.js", "index.js", "rpc-entry.js"]) {
		expect(await readFile(join(root, name), "utf8")).toBe(`original shared ${name}`);
		expect(await readFile(join(bundle, name), "utf8")).toBe(name === "cli-runtime.js" ? "bundled cli runtime" : `original shared ${name}`);
	}
});
