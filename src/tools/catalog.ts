import { rhDocumentTool } from "./rh-document.js";
import { ghDocumentTool } from "./gh-document.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRhScriptTool } from "./rh-script.js";
import { rhRunScriptTool } from "./rh-run-script.js";
import { rhQueryObjectsTool } from "./rh-query-objects.js";
import { rhViewControlTool } from "./rh-view-control.js";
import { rhCaptureViewTool } from "./rh-capture-view.js";
import { ghParamRhinoTool } from "./gh-param-rhino.js";
import {
	ghGetCanvasTool,
	ghListComponentsTool,
	ghGetCanvasErrorsTool,
} from "./query-tools.js";
import { ghEditComponentsTool } from "./edit-tools/gh-edit-components.js";
import { ghEditParamTool } from "./edit-tools/gh-edit-param.js";
import { ghEditWireTool } from "./edit-tools/gh-edit-wire.js";
import { ghEditGroupTool } from "./edit-tools/gh-edit-group.js";
import { ghCreateWidgetTool } from "./edit-tools/gh-create-widget.js";
import { ghMutateWidgetTool } from "./edit-tools/gh-mutate-widget.js";
import { ghEditScriptTool } from "./edit-tools/gh-edit-script.js";
import { ghApplyGraphTool } from "./gh-apply-graph.js";

export const HOPPER_TOOL_GROUPS = [
	"rhino",
	"gh-read",
	"gh-edit",
	"gh-script",
	"interaction",
] as const;

export type HopperToolGroup = (typeof HOPPER_TOOL_GROUPS)[number];

/** Prerequisite gate surfaced in search/diagnostics (activation still follows runtime policy). */
export type HopperToolRequires = "backend" | "images" | "ui";

/**
 * Metadata wrapper around a Pi tool definition.
 * The catalog is the source of truth for registration, keywords, core membership,
 * prerequisites, and size diagnostics.
 */
export type HopperToolCatalogEntry = {
	tool: ToolDefinition;
	group: HopperToolGroup;
	keywords: string[];
	alwaysActive?: boolean;
	requires?: HopperToolRequires;
};

type PromptTool = ToolDefinition & {
	promptSnippet?: string;
	promptGuidelines?: string[];
};

/**
 * Tools registered eagerly via `pi.registerTool` in the main Hopper extension.
 * Excludes `rh_capture_view` (model-gated dynamic registration) and
 * `hopper_search_tools` (factory that needs ExtensionAPI).
 */
export const HOPPER_REGISTERED_CATALOG: readonly HopperToolCatalogEntry[] = [
	{ tool: rhDocumentTool, group: "rhino", keywords: ["file", "open", "close", "save", "save as", "units", "tolerance", "3dm", "document settings"], requires: "backend" },
	{ tool: ghDocumentTool, group: "gh-read", keywords: ["file", "open", "close", "save", "save as", "units", "tolerance", "ghx", "document settings"], requires: "backend" },
    {
        tool: createRhScriptTool(() => { throw new Error("Script workspace must be bound by the extension factory"); }),
        group: "rhino",
        keywords: ["saved script", "virtual edit", "patch", "revision", "rhino python", "rhino csharp", "history", "units", "tolerances"],
    },
	{
		tool: rhRunScriptTool,
		group: "rhino",
		keywords: ["rhinodoc", "macro", "bake", "rhino python", "rhino csharp"],
		alwaysActive: true,
		requires: "backend",
	},
	{
		tool: rhQueryObjectsTool,
		group: "rhino",
		keywords: ["object ids", "countonly", "layer filter", "selection"],
		alwaysActive: true,
		requires: "backend",
	},
	{
		tool: rhViewControlTool,
		group: "rhino",
		keywords: ["viewport", "camera", "named view", "cplane", "zoom"],
		requires: "backend",
	},
	{
		tool: ghApplyGraphTool,
		group: "gh-edit",
		keywords: ["apply graph", "subgraph", "atomic"],
		requires: "backend",
	},
	{
		tool: ghParamRhinoTool,
		group: "gh-edit",
		keywords: ["internalize", "reference geometry", "rhinoquery"],
		requires: "backend",
	},
	{
		tool: ghCreateWidgetTool,
		group: "gh-edit",
		keywords: ["slider", "panel", "toggle", "swatch", "scribble", "value list"],
		requires: "backend",
	},
	{
		tool: ghMutateWidgetTool,
		group: "gh-edit",
		keywords: ["slider value", "panel text", "mutate widget"],
		requires: "backend",
	},
	{
		tool: ghEditComponentsTool,
		group: "gh-edit",
		keywords: ["add component", "typeguid", "nickname"],
		requires: "backend",
	},
	{
		tool: ghEditParamTool,
		group: "gh-script",
		keywords: ["script ports", "syncparams", "addinput", "typehint"],
		requires: "backend",
	},
	{
		tool: ghEditWireTool,
		group: "gh-edit",
		keywords: ["connect", "disconnect", "wire"],
		requires: "backend",
	},
	{
		tool: ghEditGroupTool,
		group: "gh-edit",
		keywords: ["group", "border"],
		requires: "backend",
	},
	{
		tool: ghEditScriptTool,
		group: "gh-script",
		keywords: ["script component", "patchcode", "setcode", "scriptparts"],
		requires: "backend",
	},
	{
		tool: ghGetCanvasTool,
		group: "gh-read",
		keywords: ["canvas", "subgraph", "selection"],
		alwaysActive: true,
		requires: "backend",
	},
	{
		tool: ghListComponentsTool,
		group: "gh-read",
		keywords: ["typeguid", "registry", "vanilla"],
		requires: "backend",
	},
	{
		tool: ghGetCanvasErrorsTool,
		group: "gh-read",
		keywords: ["runtime errors", "overlap", "warnings"],
		alwaysActive: true,
		requires: "backend",
	},
];

/** Dynamically registered and model-gated. Included in catalog for search + diagnostics. */
export const RH_CAPTURE_VIEW_CATALOG_ENTRY: HopperToolCatalogEntry = {
	tool: rhCaptureViewTool,
	group: "rhino",
	keywords: ["screenshot", "viewport image", "visual qa"],
	requires: "images",
};

/** Tools registered eagerly (backend-guarded) in registration order. */
export const ALL_TOOLS = HOPPER_REGISTERED_CATALOG.map((entry) => entry.tool);

export function getAlwaysActiveToolNames(
	catalog: readonly HopperToolCatalogEntry[],
): string[] {
	return catalog.filter((entry) => entry.alwaysActive).map((entry) => entry.tool.name);
}

export function getManagedHopperToolNames(
	catalog: readonly HopperToolCatalogEntry[],
): ReadonlySet<string> {
	return new Set(catalog.map((entry) => entry.tool.name));
}

export type ToolSchemaSize = {
	name: string;
	group: HopperToolGroup;
	alwaysActive: boolean;
	requires?: HopperToolRequires;
	descriptionBytes: number;
	parametersBytes: number;
	promptSnippetBytes: number;
	promptGuidelinesBytes: number;
	totalBytes: number;
};

export type CatalogSizeReport = {
	toolCount: number;
	alwaysActiveCount: number;
	discoverableCount: number;
	totalBytes: number;
	byGroup: Record<HopperToolGroup, { count: number; totalBytes: number }>;
	tools: ToolSchemaSize[];
};

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function emptyGroupTotals(): Record<HopperToolGroup, { count: number; totalBytes: number }> {
	return {
		rhino: { count: 0, totalBytes: 0 },
		"gh-read": { count: 0, totalBytes: 0 },
		"gh-edit": { count: 0, totalBytes: 0 },
		"gh-script": { count: 0, totalBytes: 0 },
		interaction: { count: 0, totalBytes: 0 },
	};
}

export function measureToolSchemaSize(entry: HopperToolCatalogEntry): ToolSchemaSize {
	const tool = entry.tool as PromptTool;
	const descriptionBytes = utf8Bytes(tool.description ?? "");
	const parametersBytes = utf8Bytes(JSON.stringify(tool.parameters ?? {}));
	const promptSnippetBytes = utf8Bytes(tool.promptSnippet ?? "");
	const promptGuidelinesBytes = tool.promptGuidelines?.length
		? utf8Bytes(JSON.stringify(tool.promptGuidelines))
		: 0;
	return {
		name: tool.name,
		group: entry.group,
		alwaysActive: entry.alwaysActive === true,
		requires: entry.requires,
		descriptionBytes,
		parametersBytes,
		promptSnippetBytes,
		promptGuidelinesBytes,
		totalBytes: descriptionBytes + parametersBytes + promptSnippetBytes + promptGuidelinesBytes,
	};
}

export function buildCatalogSizeReport(
	catalog: readonly HopperToolCatalogEntry[],
): CatalogSizeReport {
	const tools = catalog.map(measureToolSchemaSize).sort((a, b) => {
		if (b.totalBytes !== a.totalBytes) return b.totalBytes - a.totalBytes;
		return a.name.localeCompare(b.name);
	});
	const byGroup = emptyGroupTotals();
	for (const tool of tools) {
		const row = byGroup[tool.group];
		row.count += 1;
		row.totalBytes += tool.totalBytes;
	}
	return {
		toolCount: tools.length,
		alwaysActiveCount: tools.filter((tool) => tool.alwaysActive).length,
		discoverableCount: tools.filter((tool) => !tool.alwaysActive).length,
		totalBytes: tools.reduce((sum, tool) => sum + tool.totalBytes, 0),
		byGroup,
		tools,
	};
}

export function formatCatalogSizeReport(report: CatalogSizeReport): string {
	const lines = [
		`Hopper tool catalog: ${report.toolCount} tools, ${report.totalBytes} bytes compact schema`,
		`Always-active: ${report.alwaysActiveCount}; discoverable/conditional: ${report.discoverableCount}`,
		"",
		"By group:",
	];
	for (const group of HOPPER_TOOL_GROUPS) {
		const row = report.byGroup[group];
		lines.push(`  ${group}: ${row.count} tools, ${row.totalBytes} bytes`);
	}
	lines.push("", "By tool (largest first):");
	for (const tool of report.tools) {
		const flags = [
			tool.alwaysActive ? "core" : "discoverable",
			tool.requires ? `requires=${tool.requires}` : null,
		].filter(Boolean);
		lines.push(
			`  ${tool.name}  ${tool.totalBytes} B  (${tool.group}; ${flags.join(", ")})` +
				`  desc=${tool.descriptionBytes} params=${tool.parametersBytes}` +
				` snippet=${tool.promptSnippetBytes} guidelines=${tool.promptGuidelinesBytes}`,
		);
	}
	return lines.join("\n");
}
