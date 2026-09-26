import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

// Bundle within each installed package so all consumers, including Jiti-loaded
// extensions, share its exports and module state. Keep dependencies external.
// These ESM trees have no package-relative assets, workers or native loaders.
export const DEPENDENCY_BUNDLES = Object.freeze([
	{
		name: "typebox", version: "1.3.27", directory: "build", extension: ".mjs",
		entries: {
			".": "index", "./schema": "schema/index", "./system": "system/index",
			"./compile": "compile/index", "./value": "value/index", "./type": "type/index",
			"./error": "error/index", "./format": "format/index", "./guard": "guard/index",
		},
	},
	{
		name: "@earendil-works/pi-agent-core", version: "0.87.1", directory: "dist", extension: ".js",
		entries: {
			".": "index", "./node": "node", "./harness/context": "harness/context",
			"./experimental/pico3": "harness/pico3/index",
			"./harness/env/nodejs": "harness/env/nodejs",
			"./harness/runtime/reducer": "harness/runtime/reducer",
			"./harness/session": "harness/session/index",
			"./harness/session/testing": "harness/session/testing/index",
		},
	},
]);

export async function bundleRhinoDependencies(nodeModules) {
	const plans = [];
	for (const rule of DEPENDENCY_BUNDLES) {
		const root = resolve(nodeModules, rule.name);
		const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
		const exports = { ...manifest.exports };
		if (exports["./package.json"] === "./package.json") delete exports["./package.json"];
		if (manifest.version !== rule.version || manifest.type !== "module"
			|| JSON.stringify(Object.keys(exports).sort()) !== JSON.stringify(Object.keys(rule.entries).sort())
			|| Object.entries(rule.entries).some(([name, path]) => {
				const expected = `./${rule.directory}/${path}${rule.extension}`;
				return exports[name]?.import !== expected
					|| Object.entries(exports[name]).some(([condition, target]) => condition !== "types" && target !== expected);
			})) {
			throw new Error(`Review dependency bundling for ${rule.name} ${manifest.version}: version or exports changed`);
		}
		const directory = resolve(root, rule.directory);
		const result = await build({
			absWorkingDir: root,
			entryPoints: Object.fromEntries(Object.values(rule.entries).map(path => [path, `./${rule.directory}/${path}${rule.extension}`])),
			outdir: directory,
			outExtension: { ".js": rule.extension },
			chunkNames: "chunks/[name]-[hash]",
			bundle: true, splitting: true, packages: "external", platform: "node",
			target: "node22.19", format: "esm", minify: true, keepNames: true,
			legalComments: "eof", metafile: true, write: false,
			allowOverwrite: true,
		});
		// Do not silently incorporate another package or a file outside the audited tree.
		for (const input of Object.keys(result.metafile.inputs)) {
			const path = relative(directory, resolve(root, input));
			if (isAbsolute(path) || path.startsWith("..") || !path.endsWith(rule.extension)) {
				throw new Error(`Review dependency bundling input for ${rule.name}: ${input}`);
			}
		}
		plans.push({ rule, directory, result });
	}
	// Build and validate everything before replacing any staged runtime files.
	for (const { directory, result } of plans) {
		await rm(directory, { recursive: true });
		for (const file of result.outputFiles) {
			await mkdir(dirname(file.path), { recursive: true });
			await writeFile(file.path, file.contents);
		}
	}
	return plans.map(({ rule, result }) => ({
		name: rule.name,
		inputFiles: Object.keys(result.metafile.inputs).length,
		outputFiles: result.outputFiles.length,
		bytes: result.outputFiles.reduce((total, file) => total + file.contents.length, 0),
	}));
}
