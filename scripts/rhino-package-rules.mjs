import { extname } from "node:path";

export const RHINO_PACKAGE_TARGETS = Object.freeze({
	// Measured with Pi 0.85.1 and Excalidraw; see docs/rhino-package-baselines.md.
	"mac-arm64": Object.freeze({ os: "darwin", cpu: "arm64", maxStagedBytes: 128 * 1024 * 1024 }),
	"win-x64": Object.freeze({ os: "win32", cpu: "x64", maxStagedBytes: 128 * 1024 * 1024 }),
});

export const PACKAGE_MANIFEST_NAME = "rhino-package-manifest.json";
const ROOT_RUNTIME_FILES = new Set([
	"AsyncIO.dll",
	"Hopper.Core.dll",
	"Hopper.Grasshopper.deps.json",
	"Hopper.Grasshopper.gha",
	"Hopper.Grasshopper.runtimeconfig.json",
	"Hopper.Rhino.deps.json",
	"Hopper.Rhino.rhp",
	"Hopper.Rhino.runtimeconfig.json",
	"LICENSE",
	"Microsoft.Bcl.AsyncInterfaces.dll",
	"Microsoft.Extensions.ObjectPool.dll",
	"Microsoft.Win32.SystemEvents.dll",
	"NaCl.dll",
	"NetMQ.dll",
	"System.Drawing.Common.dll",
	"System.Private.ServiceModel.dll",
	"System.Security.Cryptography.Pkcs.dll",
	"System.Security.Cryptography.Xml.dll",
	"System.Security.Permissions.dll",
	"System.ServiceModel.Primitives.dll",
	"System.ServiceModel.dll",
	"System.Windows.Extensions.dll",
	"manifest.yml",
	"rhino-package-manifest.json",
]);

export const PACKAGE_DENY_RULES = Object.freeze([
	{
		id: "unsafe-path",
		description: "absolute paths and parent traversal are forbidden",
		test: (path) => path.startsWith("/") || path === ".." || path.startsWith("../") || path.includes("/../"),
	},
	{
		id: "os-metadata",
		description: "operating-system metadata is not runtime content",
		test: (path) => path.split("/").some((part) => part === ".DS_Store" || part === "Thumbs.db"),
	},
	{
		id: "retired-host-assembly",
		description: "the Rhino host is part of Hopper.Rhino.rhp and must not ship as a separate assembly",
		test: (path) => /(^|\/)Hopper\.Rhino\.Host\.dll$/i.test(path),
	},
	{
		id: "tests",
		description: "test files and test directories are not shipped",
		test: (path) => /(^|\/)(__tests__|tests?)(\/|$)/i.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path),
	},
	{
		id: "first-party-source-map",
		description: "release TypeScript output must not contain source maps",
		test: (path) => path.startsWith("runtime/host/dist/") && path.endsWith(".map"),
	},
	{
		id: "lockfile",
		description: "package-manager lockfiles are installer inputs",
		test: (path) => /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock)$/i.test(path)
			|| /(^|\/)\.pnpm\/lock\.yaml$/i.test(path),
	},
	{
		id: "workspace-file",
		description: "workspace configuration is an installer input",
		test: (path) => /(^|\/)(pnpm-workspace\.yaml|\.pnpm-workspace-state-v1\.json)$/i.test(path),
	},
	{
		id: "package-manager-metadata",
		description: "package-manager installation metadata is not needed at runtime",
		test: (path) => /(^|\/)\.modules\.yaml$/i.test(path),
	},
	{
		id: "development-tree",
		description: "source, build, and installer trees are not runtime content",
		test: (path) => /^(src|grasshopper-plugin|scripts|bin|obj|artifacts|coverage)(\/|$)/i.test(path)
			|| /^runtime\/host\/(src|grasshopper-plugin|scripts)(\/|$)/i.test(path),
	},
	{
		id: "node-executable",
		description: "Node is an external prerequisite and must not be bundled",
		test: (path) => /(^|\/)(node|node\.exe)$/i.test(path) || /^runtime\/node(\/|$)/i.test(path),
	},
	{
		id: "package-manager-bin",
		description: "package-manager command shims are not runtime content",
		test: (path) => /(^|\/)\.bin(\/|$)/.test(path),
	},
	{
		id: "known-development-module",
		description: "known development-only modules are not shipped",
		test: (path) => /^runtime\/host\/node_modules\/(?:@types|typescript|tsx|vitest|vite)(\/|$)/.test(path),
	},
	{
		id: "duplicate-esbuild-cli",
		description: "esbuild's JS API uses the native binary in @esbuild; its CLI copy is not shipped",
		test: (path) => /^runtime\/host\/node_modules\/esbuild\/bin(\/|$)/.test(path),
	},
]);

export const PACKAGE_ALLOW_RULES = Object.freeze([
	{
		id: "yak-artifact",
		description: "Yak archives may be emitted beside the staged payload",
		test: (path) => extname(path).toLowerCase() === ".yak" && !path.includes("/"),
	},
	{
		id: "root-runtime-file",
		description: "only the known managed plug-in files and Yak metadata live at the package root",
		test: (path) => !path.includes("/") && ROOT_RUNTIME_FILES.has(path),
	},
	{
		id: "runtime-manifest",
		description: "the Rhino host launcher reads its runtime manifest",
		test: (path) => path === "runtime/hopper-runtime.json",
	},
	{
		id: "host-package-metadata",
		description: "Node needs package metadata for ESM and dependency resolution",
		test: (path) => /^runtime\/host\/(package\.json|LICENSE(?:\.[A-Za-z0-9_-]+)?)$/i.test(path),
	},
	{
		id: "host-output",
		description: "compiled host code and browser assets are runtime content",
		test: (path) => path.startsWith("runtime/host/dist/"),
	},
	{
		id: "host-skills",
		description: "checked-in Hopper skills and references are runtime content",
		test: (path) => path.startsWith("runtime/host/mds/"),
	},
	{
		id: "host-dependency",
		description: "production Node dependencies are runtime content",
		test: (path) => path.startsWith("runtime/host/node_modules/"),
	},
	{
		id: "target-managed-runtime",
		description: "target-specific managed runtime support files may be staged",
		test: (path, target) => {
			const runtimeId = target === "mac-arm64" ? "osx-arm64" : "win-x64";
			return path.startsWith(`runtimes/${runtimeId}/`);
		},
	},
]);

export const NATIVE_CANDIDATE_EXTENSIONS = Object.freeze(new Set([".dll", ".dylib", ".node", ".so"]));

export function normalizePackagePath(path) {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function evaluatePackagePath(inputPath, target) {
	if (!(target in RHINO_PACKAGE_TARGETS)) {
		throw new Error(`Unsupported Rhino package target: ${target}`);
	}
	const path = normalizePackagePath(inputPath);
	const deniedBy = PACKAGE_DENY_RULES.find((rule) => rule.test(path, target));
	if (deniedBy) return { allowed: false, path, rule: deniedBy };
	const allowedBy = PACKAGE_ALLOW_RULES.find((rule) => rule.test(path, target));
	if (allowedBy) return { allowed: true, path, rule: allowedBy };
	return {
		allowed: false,
		path,
		rule: {
			id: "not-allowlisted",
			description: "path does not match a checked-in package allow rule",
		},
	};
}
