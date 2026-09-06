import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { manageDocument } from "../services/document-management.js";
import type { DocumentKind } from "../types/document-management.js";

const policy = Type.Union([Type.Literal("fail"), Type.Literal("save"), Type.Literal("discard")]);
export const DocumentParameters = Type.Object({
	action: Type.Union(["list", "get", "getSettings", "browse", "new", "open", "activate", "save", "saveAs", "close"].map((value) => Type.Literal(value))),
	documentId: Type.Optional(Type.String({ description: "Exact live handle from list/get; required for get/getSettings/activate/save/saveAs/close." })),
	expectedStateToken: Type.Optional(Type.String({ description: "Fresh list/get token; required for save/saveAs/close." })),
	expectedActiveDocument: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Observed active handle, or explicit null. Required for new/open/activate." })),
	path: Type.Optional(Type.String({ description: "Absolute native file path for open/saveAs, directory for browse." })),
	templatePath: Type.Optional(Type.String({ description: "Absolute native template path for new; creates an unnamed document." })),
	createDirectories: Type.Optional(Type.Boolean({ description: "Explicitly create missing parent directories for saveAs or a pre-close savePath. Defaults to false." })),
	onUnsaved: Type.Optional(policy),
	savePath: Type.Optional(Type.String({ description: "Absolute destination when saving an unnamed document before close." })),
	overwrite: Type.Optional(Type.Boolean({ description: "Explicitly allow replacing an existing file. Does not override another live document's ownership." })),
	affectedDocuments: Type.Optional(Type.Array(Type.Object({
		documentId: Type.String(), expectedStateToken: Type.String(), onUnsaved: policy,
		savePath: Type.Optional(Type.String()), overwrite: Type.Optional(Type.Boolean()),
		createDirectories: Type.Optional(Type.Boolean({ description: "Create missing parent directories for this affected document savePath." })),
	}), { description: "Required for new/open. Include every replaced document with its fresh token and unsaved policy; [] if none." })),
	cursor: Type.Optional(Type.String({ description: "Opaque cursor from the preceding browse page." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Browse page size." })),
});

export function createDocumentTool(kind: DocumentKind) {
	return defineTool({
		name: kind === "rhino" ? "rh_document" : "gh_document",
		label: `${kind === "rhino" ? "Rhino" : "Grasshopper"} Documents`,
		description: `Inspect units/tolerances and manage ${kind === "rhino" ? "Rhino .3dm" : "Grasshopper .gh/.ghx"} files. ` +
			"One action per call. Start with list and getSettings before dimensional modeling. Browse discovers native files without opening them. " +
			"Use exact document handles and fresh state tokens. close requires onUnsaved; discard only when the user authorized losing changes. " +
			"File transitions finish the current editing segment. Inspect partial effects after failures; never replay an uncertain mutation. " +
			"Read capabilities for platform limits. Settings inspection does not modify units or tolerances.",
		parameters: DocumentParameters,
		async execute(_id, params) {
			try {
				const result = await manageDocument(kind, params as Parameters<typeof manageDocument>[1]);
				const failed = !!result && typeof result === "object" && "ok" in result && result.ok === false;
				return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: {}, ...(failed ? { isError: true } : {}) };
			} catch (error) {
				return { content: [{ type: "text" as const, text: `FAILED: ${error instanceof Error ? error.message : String(error)}` }], details: {}, isError: true };
			}
		},
	});
}
