import { access, cp, link, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { afterEach, expect, it } from "vitest";
import { bundlePiRuntime, deferUndiciImport } from "./bundle-pi-runtime.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
	// macOS aliases /var to /private/var; use one URL for both module imports.
	const root = await realpath(await mkdtemp(join(tmpdir(), "hopper-pi-runtime-")));
	roots.push(root);
	const pkg = join(root, "@earendil-works/pi-coding-agent");
	await mkdir(join(pkg, "dist/core"), { recursive: true });
	await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", version: "0.87.1", exports: { ".": { import: "./dist/index.js" } } }));
	await writeFile(join(pkg, "dist/index.js"), 'export { Session, originalUrl, workerUrl, readAsset } from "./core/session.js";');
	await writeFile(join(pkg, "dist/core/session.js"), `
		import { readFileSync } from "node:fs";
		export class Session {}
		export const originalUrl = import.meta.url;
		export const workerUrl = new URL("./worker.js", import.meta.url).href;
		export const readAsset = () => readFileSync(new URL("./asset.txt", import.meta.url), "utf8");
	`);
	await writeFile(join(pkg, "dist/core/asset.txt"), "asset");
	return { root, pkg };
}

it("preserves source-relative assets and one public SDK identity after relocation", async () => {
	const { root, pkg } = await fixture();
	const sharedFile = join(root, "store-original.js");
	await link(join(pkg, "dist/index.js"), sharedFile);
	const original = await readFile(sharedFile, "utf8");
	const result = await bundlePiRuntime(root);
	expect(await readFile(sharedFile, "utf8")).toBe(original);
	expect(result.inputs).toBe(2);
	expect(result.outputs).toBe(1);
	// Moving the whole staged tree catches accidental build-machine absolute URLs.
	const relocated = join(dirname(root), `${root.split(/[\\/]/).at(-1)}-relocated`);
	roots.push(relocated);
	const { rename } = await import("node:fs/promises");
	await rename(root, relocated);
	const movedPackage = join(relocated, "@earendil-works/pi-coding-agent");
	const sdk = await import(pathToFileURL(join(movedPackage, "dist/index.js")).href);
	const implementation = await import(pathToFileURL(join(movedPackage, "dist/hopper-runtime/index.js")).href);
	expect(sdk.Session).toBe(implementation.Session);
	expect(fileURLToPath(sdk.originalUrl)).toBe(join(movedPackage, "dist/core/session.js"));
	expect(fileURLToPath(sdk.workerUrl)).toBe(join(movedPackage, "dist/core/worker.js"));
	expect(sdk.readAsset()).toBe("asset");
	await expect(bundlePiRuntime(relocated)).rejects.toThrow("already bundled");
});

it("fails before modifying an unsupported package and refuses development dependencies", async () => {
	const { root, pkg } = await fixture();
	const entry = join(pkg, "dist/index.js");
	const original = await readFile(entry, "utf8");
	const manifestPath = join(pkg, "package.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	manifest.version = "0.86.0";
	await writeFile(manifestPath, JSON.stringify(manifest));
	await expect(bundlePiRuntime(root)).rejects.toThrow("Review Pi");
	expect(await readFile(entry, "utf8")).toBe(original);
	await expect(bundlePiRuntime(resolve("node_modules"))).rejects.toThrow("development node_modules");
});

it("defers the audited HTTP client until configuration while retaining dispatcher behavior", async () => {
	const { root, pkg } = await fixture();
	const source = await readFile(new URL("./core/http-dispatcher.js", import.meta.resolve("@earendil-works/pi-coding-agent")), "utf8");
	expect(() => deferUndiciImport(source + "\n")).toThrow("Review changed Pi HTTP dispatcher");
	await writeFile(join(pkg, "dist/core/http-dispatcher.js"), source);
	await writeFile(join(pkg, "dist/index.js"), 'export * from "./core/http-dispatcher.js";');
	const undici = join(root, "node_modules/undici");
	await mkdir(undici, { recursive: true });
	await writeFile(join(undici, "package.json"), JSON.stringify({ name: "undici", main: "index.cjs" }));
	await writeFile(join(undici, "index.cjs"), `
		const { EventEmitter } = require("node:events");
		class Dispatcher extends EventEmitter { constructor(...args) { super(); this.args = args; } }
		exports.Client = exports.Pool = exports.EnvHttpProxyAgent = Dispatcher;
		exports.installed = 0;
		exports.setGlobalDispatcher = value => { exports.current = value; };
		exports.install = () => { exports.installed++; };
	`);
	await bundlePiRuntime(root);
	const require = createRequire(join(pkg, "dist/index.js"));
	const clientPath = require.resolve("undici");
	const sdk = await import(pathToFileURL(join(pkg, "dist/index.js")).href);
	expect(sdk.DEFAULT_HTTP_IDLE_TIMEOUT_MS).toBe(300000);
	expect(sdk.parseHttpIdleTimeoutMs("disabled")).toBe(0);
	expect(sdk.formatHttpIdleTimeoutMs(60000)).toBe("1 min");
	expect(() => sdk.configureHttpDispatcher(-1)).toThrow("Invalid HTTP idle timeout");
	expect(require.cache[clientPath]).toBeUndefined();
	sdk.configureHttpDispatcher(60000);
	const client = require("undici");
	expect(client.installed).toBe(1);
	const options = client.current.args[0];
	expect(options).toMatchObject({ bodyTimeout: 60000, headersTimeout: 60000, proxyTunnel: true });
	const single = options.factory("http://localhost", { connections: 1 });
	const pool = options.factory("http://localhost", { connections: 2 });
	expect(single.args[0]).toBe("http://localhost");
	expect(pool.args[1].factory("http://localhost", {}).args[0]).toBe("http://localhost");
	expect(() => single.emit("error", new Error("stream failure"))).not.toThrow();
	sdk.configureHttpDispatcher(30000);
	expect(client.current.args[0].bodyTimeout).toBe(30000);
});

it("loads real Undici on demand and completes an HTTP request through its dispatcher", async () => {
	const { root, pkg } = await fixture();
	const originalEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
	const source = await readFile(new URL("./core/http-dispatcher.js", originalEntry), "utf8");
	await writeFile(join(pkg, "dist/core/http-dispatcher.js"), source);
	await writeFile(join(pkg, "dist/index.js"), 'export * from "./core/http-dispatcher.js";');
	const dependency = dirname(createRequire(originalEntry).resolve("undici/package.json"));
	await mkdir(join(root, "node_modules"));
	await symlink(dependency, join(root, "node_modules/undici"), "junction");
	await bundlePiRuntime(root);
	// Dispatcher configuration installs fetch globals, so exercise it in a child.
	const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
		import assert from "node:assert/strict";
		import { createServer } from "node:http";
		import { createRequire } from "node:module";
		const url = ${JSON.stringify(pathToFileURL(join(pkg, "dist/index.js")).href)};
		const require = createRequire(url);
		const clientPath = require.resolve("undici");
		const sdk = await import(url);
		assert.equal(require.cache[clientPath], undefined);
		for (const key of Object.keys(process.env)) if (/^(http|https|all|no)_proxy$/i.test(key)) delete process.env[key];
		const server = createServer((req, res) => res.end("lazy dispatcher works"));
		await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
		sdk.configureHttpDispatcher(1000);
		const client = require("undici");
		try {
			const response = await fetch("http://127.0.0.1:" + server.address().port);
			assert.equal(await response.text(), "lazy dispatcher works");
		} finally {
			await client.getGlobalDispatcher().close();
			await new Promise(resolve => server.close(resolve));
		}
	`], { encoding: "utf8", timeout: 10000, windowsHide: true });
	expect(child.error).toBeUndefined();
	expect(child.status, child.stderr).toBe(0);
});

it("keeps Jiti unloaded for the SDK and inline factories, then loads real typed extensions on demand", async () => {
	const { root, pkg } = await fixture();
	const originalDist = await realpath(fileURLToPath(new URL("./", import.meta.resolve("@earendil-works/pi-coding-agent"))));
	await cp(originalDist, join(pkg, "dist"), {
		recursive: true,
		filter: path => path !== join(originalDist, "bundle") && !/\.map$|\.d\.[cm]?ts$/.test(path),
	});
	// Share real external dependencies without modifying them. The SDK itself is
	// copied so its audited bundler can replace only this fixture's entry files.
	const originalRequire = createRequire(join(originalDist, "index.js"));
	const manifest = JSON.parse(await readFile(join(originalDist, "../package.json"), "utf8"));
	for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
		let target: string | undefined;
		for (const parent of originalRequire.resolve.paths(name) ?? []) {
			const path = join(parent, name);
			if (await access(path).then(() => true, () => false)) { target = await realpath(path); break; }
		}
		if (!target && name in manifest.optionalDependencies) continue;
		if (!target) throw new Error(`Missing SDK fixture dependency: ${name}`);
		const linkPath = join(root, "node_modules", name);
		await mkdir(dirname(linkPath), { recursive: true });
		await symlink(target, linkPath, "junction");
	}
	await bundlePiRuntime(root);
	const extension = join(root, "extension.ts");
	await writeFile(extension, `
		import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
		import { Type } from "typebox";
		import { Type as PiType } from "@earendil-works/pi-ai";
		if (Type.Object !== PiType.Object) throw new Error("duplicate schema state");
		const label: string = "typed-on-demand";
		export default (pi: ExtensionAPI) => { pi.registerTool({ name: label, label, description: label,
			parameters: Type.Object({}), execute: async () => ({content: [{type: "text", text: label}], details: {}}) }); };
	`);
	const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
		import assert from 'node:assert/strict';
		import { createRequire } from 'node:module';
		import { fileURLToPath } from 'node:url';
		import { join } from 'node:path';
		const url = ${JSON.stringify(pathToFileURL(join(pkg, "dist/index.js")).href)};
		const require = createRequire(url);
		const jitiRoot = new URL('../', import.meta.resolve('jiti/static'));
		const babelPath = require.resolve(fileURLToPath(new URL('dist/babel.cjs', jitiRoot)));
		const hasJiti = () => Object.keys(require.cache).some(path => /[\\\\/]jiti[\\\\/]dist[\\\\/]/.test(path));
		const pi = await import(url);
		assert.equal(hasJiti(), false);
		const cwd = process.cwd(), agentDir = join(cwd, 'agent');
		const empty = await pi.discoverAndLoadExtensions([], cwd, agentDir);
		assert.deepEqual(empty.errors, []);
		const loader = new pi.DefaultResourceLoader({cwd, agentDir, noExtensions: true, noSkills: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [{name: 'inline', factory: api => api.registerCommand('inline-test', {description: 'test', handler: async () => {}})}]});
		await loader.reload();
		assert.equal(loader.getExtensions().extensions.length, 1);
		assert.equal(hasJiti(), false);
		const loaded = await pi.discoverAndLoadExtensions([${JSON.stringify(extension)}], cwd, agentDir);
		assert.deepEqual(loaded.errors, []);
		assert.ok(loaded.extensions[0].tools.has('typed-on-demand'));
		assert.ok(require.cache[babelPath]);
		const again = await pi.discoverAndLoadExtensions([${JSON.stringify(extension)}], cwd, agentDir);
		assert.deepEqual(again.errors, []);
		const missing = await pi.discoverAndLoadExtensions([join(cwd,'missing.ts')], cwd, agentDir);
		assert.equal(missing.errors.length, 1);
	`], { cwd: root, encoding: "utf8", timeout: 20000, windowsHide: true,
		env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "global-agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0" } });
	expect(child.error).toBeUndefined();
	expect(child.status, child.stderr).toBe(0);
}, 30000);
