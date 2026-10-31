import { link, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { bundlePiRuntime } from "./bundle-pi-runtime.mjs";

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
