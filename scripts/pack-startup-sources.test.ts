import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { packStartupSources, STARTUP_SOURCE_ARCHIVE } from "./pack-startup-sources.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "hopper-source-pack-"));
	roots.push(root);
	const project = join(root, "original");
	const modules = join(project, "node_modules");
	const pkg = join(modules, "fixture.pkg");
	await mkdir(join(pkg, "legacy"), { recursive: true });
	await writeFile(join(pkg, "package.json"), JSON.stringify({ type: "module", exports: { ".": "./index.js", "./legacy": "./legacy/index.js" } }));
	await writeFile(join(pkg, "index.js"), 'export * from "./state.js"; export const originalUrl = import.meta.url;');
	await writeFile(join(pkg, "state.js"), 'export const identity = {}; export let count = 0; export function increment() { count++; }');
	await writeFile(join(pkg, "legacy/package.json"), '{"type":"commonjs"}');
	await writeFile(join(pkg, "legacy/index.js"), `
		exports.fromCycle = require('./cycle.cjs').value;
		exports.filename = __filename;
		exports.resolvePaths = require.resolve.paths('fixture.pkg');
		exports.asset = require('node:fs').readFileSync(require('node:path').join(__dirname, '../asset.txt'), 'utf8');
	`);
	await writeFile(join(pkg, "legacy/cycle.cjs"), 'exports.value = 42; exports.parent = require("./index.js");');
	await writeFile(join(pkg, "asset.txt"), "asset");
	await writeFile(join(pkg, "later.mjs"), 'export const value = "archive";');
	await writeFile(join(pkg, "worker.mjs"), 'import { parentPort } from "node:worker_threads"; parentPort.postMessage("worker");');
	await build({ entryPoints: [resolve("src/host/startup-sources.ts")], outfile: join(project, "loader.mjs"), bundle: true, platform: "node", format: "esm" });
	return { root, project, modules, pkg };
}

it("serves original ESM and CJS sources after relocation, then releases hooks for later imports", async () => {
	const f = await fixture();
	const packed = await packStartupSources(f.modules, ["fixture.pkg", "missing-optional"]);
	expect(packed.files).toBe(6);
	const archive = JSON.parse(gunzipSync(await readFile(join(f.modules, STARTUP_SOURCE_ARCHIVE))).toString());
	expect(archive.modules["fixture.pkg/legacy/index.js"].format).toBe("commonjs");
	expect(archive.modules["fixture.pkg/index.js"].format).toBe("module");
	expect(archive.modules["fixture.pkg/asset.txt"]).toBeUndefined();
	// Actual source files now fail if the loader falls through to disk.
	for (const file of ["index.js", "state.js", "legacy/index.js", "legacy/cycle.cjs"])
		await writeFile(join(f.pkg, file), 'throw new Error("source read from disk");');
	await writeFile(join(f.pkg, "later.mjs"), 'export const value = "disk after release";');
	const relocated = join(f.root, "relocated space # % 日本語");
	await rename(f.project, relocated);
	const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
		import assert from 'node:assert/strict';
		import { createRequire } from 'node:module';
		import { pathToFileURL } from 'node:url';
		import { Worker } from 'node:worker_threads';
		const root = pathToFileURL(process.cwd() + '/');
		const {loadStartupSources} = await import(new URL('loader.mjs', root));
		const release = await loadStartupSources(process.cwd());
		const esm = await import('fixture.pkg');
		const deep = await import(new URL('node_modules/fixture.pkg/state.js', root));
		assert.equal(esm.identity, deep.identity);
		esm.increment(); assert.equal(deep.count, 1); assert.equal(esm.count, 1);
		assert.equal(esm.originalUrl, new URL('node_modules/fixture.pkg/index.js', root).href);
		const require = createRequire(new URL('fixture.mjs', root));
		const cjs = require('fixture.pkg/legacy');
		assert.equal(cjs, (await import('fixture.pkg/legacy')).default);
		assert.equal(require.cache[require.resolve('fixture.pkg/legacy')].exports, cjs);
		assert.equal(cjs.fromCycle, 42); assert.equal(cjs.asset, 'asset');
		assert.ok(cjs.filename.startsWith(process.cwd())); assert.ok(cjs.resolvePaths.length);
		await assert.rejects(import(new URL('node_modules/fixture.pkg/index.js?different', root)), /source read from disk/);
		release(); release();
		assert.equal((await import(new URL('node_modules/fixture.pkg/later.mjs', root))).value, 'disk after release');
		assert.equal((await import('fixture.pkg')).identity, esm.identity);
		const worker = new Worker(new URL('node_modules/fixture.pkg/worker.mjs', root), {execArgv: []});
		try { assert.equal(await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }), 'worker'); }
		finally { await worker.terminate(); }
	`], { cwd: relocated, encoding: "utf8", timeout: 10000, windowsHide: true });
	expect(child.error).toBeUndefined();
	expect(child.status, child.stderr).toBe(0);
});
