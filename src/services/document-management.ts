import { posix, win32 } from "node:path";
import { withRequester } from "../infra/request-helpers.js";
import type { DocumentKind, DocumentRequest, DocumentSettings } from "../types/document-management.js";

const actions = new Set(["list", "get", "getSettings", "browse", "new", "open", "activate", "save", "saveAs", "close"]);
const policies = new Set(["fail", "save", "discard"]);
function absolute(path: string, field: string): void {
	if ((!posix.isAbsolute(path) && !win32.isAbsolute(path)) || /[\x00-\x1f]/.test(path))
		throw new Error(`${field} must be an absolute path without control characters.`);
}
function required(value: unknown, field: string): void {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
}

/** Validate action requirements before any RPC, including calls that bypass schema validation. */
export function validateDocumentRequest(kind: DocumentKind, request: DocumentRequest): void {
	if (!actions.has(request.action)) throw new Error("Unknown document action.");
	if (["get", "getSettings", "activate", "save", "saveAs", "close"].includes(request.action)) required(request.documentId, "documentId");
	if (["save", "saveAs", "close"].includes(request.action)) required(request.expectedStateToken, "expectedStateToken");
	if (["new", "open", "activate"].includes(request.action)) {
		if (request.expectedActiveDocument !== null) required(request.expectedActiveDocument, "expectedActiveDocument (use explicit null for no active document)");
	}
	if (["new", "open"].includes(request.action) && !Array.isArray(request.affectedDocuments))
		throw new Error("affectedDocuments is required; use [] when no documents will be replaced.");
	if (["browse", "open", "saveAs"].includes(request.action)) required(request.path, "path");
	if (request.action === "close" && !request.onUnsaved) throw new Error("onUnsaved is required for close.");
	if (request.templatePath !== undefined && request.action !== "new") throw new Error("templatePath is only supported for new.");
	if (request.action === "new" && request.path !== undefined) throw new Error("Use templatePath for new.");
	if (request.onUnsaved && !policies.has(request.onUnsaved)) throw new Error("Invalid onUnsaved policy.");
	for (const [field, path] of [["path", request.path], ["savePath", request.savePath], ["templatePath", request.templatePath]] as const) {
		if (path !== undefined) {
			absolute(path, field);
			if (!(field === "path" && request.action === "browse")) {
				const extension = posix.extname(path.replaceAll("\\", "/")).toLowerCase();
				if (!(kind === "rhino" ? [".3dm"] : [".gh", ".ghx"]).includes(extension)) throw new Error(`Unsupported ${kind} file extension: ${extension}`);
			}
		}
	}
	const seen = new Set<string>();
	for (const affected of request.affectedDocuments ?? []) {
		required(affected.documentId, "affectedDocuments.documentId");
		required(affected.expectedStateToken, "affectedDocuments.expectedStateToken");
		if (seen.has(affected.documentId)) throw new Error("affectedDocuments contains duplicate documentId.");
		seen.add(affected.documentId);
		if (!policies.has(affected.onUnsaved)) throw new Error("affectedDocuments.onUnsaved is required.");
		if (affected.savePath !== undefined) validateDocumentRequest(kind, { action: "saveAs", documentId: affected.documentId, expectedStateToken: affected.expectedStateToken, path: affected.savePath });
	}
	if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 200)) throw new Error("limit must be an integer from 1 to 200.");
}

export async function manageDocument(kind: DocumentKind, request: DocumentRequest): Promise<unknown> {
	validateDocumentRequest(kind, request);
	const owner = kind === "rhino" ? "Rhino" : "Grasshopper";
	let args: Record<string, unknown>;
	switch (request.action) {
		case "list": args = { type: `list${owner}Documents` }; break;
		case "get": args = { type: `get${owner}Document`, documentId: request.documentId }; break;
		case "getSettings": args = { type: `get${owner}DocumentSettings`, documentId: request.documentId }; break;
		case "browse": args = { type: "browseDocumentFiles", kind, path: request.path, cursor: request.cursor, limit: request.limit }; break;
		default: args = { type: `manage${owner}Document`, ...request }; break;
	}
	return withRequester((requester) => requester.request(args));
}

export function formatDocumentSettings(settings?: DocumentSettings | null): string {
	if (!settings) return "";
	const effective = settings.settings ?? settings;
	if (!effective.model) return `Document ${settings.documentId}: modeling context unresolved (revision ${settings.settingsRevision}).\n`;
	const model = effective.model;
	return `Document ${settings.documentId}: units=${model.units.name}; absolute tolerance=${model.absoluteTolerance} model units; angle=${model.angleToleranceDegrees} degrees; relative=${model.relativeToleranceRatio} ratio; settings revision=${settings.settingsRevision}` +
		(settings.sourceDocumentId ? `; Rhino source=${settings.sourceDocumentId}` : "") +
		(settings.contextMismatch ? "; associated and active Rhino documents differ" : "") + ".\n";
}
