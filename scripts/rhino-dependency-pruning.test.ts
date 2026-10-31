import { link, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { deduplicatePiBundle } from "./prune-rhino-host.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

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
