import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { DEPENDENCY_PRUNE_RULES } from "./rhino-dependency-pruning.mjs";
import { join } from "node:path";

async function replaceStagedFile(path, contents) {
	// pnpm may hardlink staged files to its store and the development install.
	// Replace the directory entry instead of overwriting the shared inode.
	const temporary = `${path}.${randomUUID()}.tmp`;
	const { mode } = await lstat(path);
	try {
		await writeFile(temporary, contents, { flag: "wx", mode });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

// Pi publishes a complete bundled SDK alongside its ordinary SDK entry.
// Retain the public entry paths, but share Hopper's consolidated SDK. Keep the
// original SDK, native binaries, image worker, WASM, themes, docs and templates.
export async function deduplicatePiBundle(nodeModules) {
	const root = join(nodeModules, "@earendil-works/pi-coding-agent");
	const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	if (manifest.version !== "0.87.1") {
		throw new Error(`Review Pi bundle deduplication for version ${manifest.version} before packaging`);
	}
	const bundle = join(root, "dist/bundle");
	const expected = ["chunks", "cli-runtime.js", "cli.js", "index.js", "rpc-entry.js"];
	const actual = (await readdir(bundle)).sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`Unexpected Pi bundle files: ${actual.join(", ")}`);
	}
	// Check all replacement targets before removing any bundled code.
	for (const name of ["cli.js", "index.js", "rpc-entry.js"]) {
		await readFile(join(root, "dist", name), "utf8");
	}
	for (const name of ["cli.js", "rpc-entry.js"]) {
		await replaceStagedFile(join(bundle, name), `#!/usr/bin/env node\nimport "../${name}";\n`);
	}
	await replaceStagedFile(join(bundle, "index.js"), 'export * from "../index.js";\n');
	await rm(join(bundle, "cli-runtime.js"));
	await rm(join(bundle, "chunks"), { recursive: true });
}

export async function pruneAuditedDependencies(nodeModules) {
	// Validate every package and path before deleting anything. Upgrades fail closed.
	for (const rule of DEPENDENCY_PRUNE_RULES) {
		const root = join(nodeModules, rule.name);
		const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		if (manifest.version !== rule.version) {
			throw new Error(`Review dependency pruning for ${rule.name} ${manifest.version}; audited ${rule.version}`);
		}
		for (const path of rule.paths) await lstat(join(root, path));
	}
	for (const rule of DEPENDENCY_PRUNE_RULES) {
		for (const path of rule.paths) await rm(join(nodeModules, rule.name, path), { recursive: true });
	}
}
