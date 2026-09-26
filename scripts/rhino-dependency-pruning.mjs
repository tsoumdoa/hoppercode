// Audited against the staged production tree. See docs/rhino-dependency-audit.md.
// Keep public runtime module formats and assets; never apply a generic src rule.
export const DEPENDENCY_PRUNE_RULES = Object.freeze([
	{ name: "openai", version: "6.40.0", paths: ["src"] },
	{ name: "@anthropic-ai/sdk", version: "0.124.0", paths: ["src"] },
	{ name: "zod", version: "4.4.3", paths: ["src"] },
	{
		name: "cmake-ts", version: "1.0.2",
		paths: ["src", "babel.config.mts", "vite.config.mts", "vitest.config.mts", "tsconfig.json",
			"build/tsconfig.tsbuildinfo", "build/main.js", "build/main.mjs", "build/lib.js", "build/lib.mjs"],
	},
]);

export function prunedDependencyPath(path) {
	return DEPENDENCY_PRUNE_RULES.some(rule => rule.paths.some(removed => {
		const prefix = `runtime/host/node_modules/${rule.name}/${removed}`;
		return path === prefix || path.startsWith(`${prefix}/`);
	}));
}
