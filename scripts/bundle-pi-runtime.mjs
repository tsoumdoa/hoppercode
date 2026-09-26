import { build, transform } from "esbuild";
import { readFile, realpath, mkdir, writeFile, lstat, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const developmentModules = resolve(dirname(fileURLToPath(import.meta.url)), "../node_modules");

// SettingsManager reads timeout constants without configuring Pi's CLI HTTP
// dispatcher. Keep that synchronous API, but load Undici only when it is used.
export function deferUndiciImport(source) {
	if (createHash("sha256").update(source).digest("hex") !== "f9aa2c81b0a5958ffba6368506f24c9b202904c234ada19494cdc9c4a1d0e97b")
		throw new Error("Review changed Pi HTTP dispatcher before deferring Undici");
	return source.replace('import * as undici from "undici";', [
		'import { createRequire as createUndiciRequire } from "node:module";',
		'const requireUndici = createUndiciRequire(import.meta.url);',
		'let undici;',
		'const loadUndici = () => undici ??= requireUndici("undici");',
	].join("\n")).replace(/new undici\.(\w+)/g, "new (loadUndici().$1)")
		.replace(/\bundici\./g, "loadUndici().");
}

function inside(root, path) {
	const local = relative(root, path);
	return local && local !== ".." && !local.startsWith("../") && !local.startsWith("..\\") && !isAbsolute(local);
}

// Package only Pi's JavaScript here. Native dependencies and their runtime assets
// stay at their installed paths. A single SDK entry keeps extension aliases and
// Hopper's sessions on the same implementation.
export async function bundlePiRuntime(nodeModules) {
	const modules = await realpath(resolve(nodeModules));
	if (modules === await realpath(developmentModules)) throw new Error("Refusing to bundle development node_modules");
	const directory = resolve(modules, "@earendil-works/pi-coding-agent");
	if (await realpath(directory) !== directory) throw new Error("Pi runtime bundling requires a staged package without links");
	const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
	if (manifest.name !== "@earendil-works/pi-coding-agent" || manifest.type !== "module" ||
		manifest.version !== "0.87.1" || manifest.exports?.["."]?.import !== "./dist/index.js")
		throw new Error("Review Pi runtime bundling for this package version/layout");
	const entry = join(directory, "dist/index.js");
	const output = join(directory, "dist/hopper-runtime");
	if (await realpath(dirname(entry)) !== dirname(entry)) throw new Error("Pi dist must not be a symlink");
	if (await lstat(output).catch(error => { if (error.code !== "ENOENT") throw error; }))
		throw new Error("Pi runtime is already bundled; use a fresh staging tree");
	const result = await build({
		absWorkingDir: directory,
		entryPoints: [entry],
		outdir: output,
		bundle: true,
		packages: "external",
		splitting: true,
		chunkNames: "[name]-[hash]",
		platform: "node",
		target: "node22.19",
		format: "esm",
		minify: true,
		keepNames: true,
		metafile: true,
		write: false,
		plugins: [{
			name: "preserve-pi-module-origins",
			setup(bundler) {
				bundler.onLoad({ filter: /\.js$/ }, async ({ path }) => {
					if (!inside(directory, path) || await realpath(path) !== path)
						throw new Error("Pi source escaped its staged package");
					let source = await readFile(path, "utf8");
					if (relative(directory, path).replaceAll("\\", "/") === "dist/core/http-dispatcher.js")
						source = deferUndiciImport(source);
					if (!source.includes("import.meta.url")) return { contents: source, loader: "js" };
					const original = relative(output, path).replaceAll("\\", "/");
					const transformed = await transform(source, {
						loader: "js", format: "esm", target: "node22.19",
						define: { "import.meta.url": "__hopperOriginalModuleUrl" },
					});
					return { contents: `const __hopperOriginalModuleUrl = new URL(${JSON.stringify(original)}, import.meta.url).href;\n${transformed.code}`, loader: "js" };
				});
			},
		}],
	});
	for (const file of result.outputFiles) {
		if (!inside(output, file.path) || dirname(file.path) !== output) throw new Error("Pi bundle output escaped staging directory");
	}
	for (const file of result.outputFiles) {
		await mkdir(dirname(file.path), { recursive: true });
		await writeFile(file.path, file.contents);
	}
	// pnpm's staged files may still share an inode with its store and other installs.
	// Replace this directory entry rather than writing through those hardlinks.
	const replacement = join(dirname(entry), `.hopper-index-${randomUUID()}.js`);
	await writeFile(replacement, 'export * from "./hopper-runtime/index.js";\n', { flag: "wx" });
	await rename(replacement, entry);
	return { inputs: Object.keys(result.metafile.inputs).length, outputs: result.outputFiles.length,
		bytes: result.outputFiles.reduce((sum, file) => sum + file.contents.length, 0) };
}
