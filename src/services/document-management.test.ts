import { describe, expect, it, vi } from "vitest";
const { request } = vi.hoisted(() => ({ request: vi.fn(async (args) => args) }));
vi.mock("../infra/request-helpers.js", () => ({ withRequester: (fn: (req: { request: typeof request }) => unknown) => fn({ request }) }));
import { manageDocument, validateDocumentRequest } from "./document-management.js";

describe("document tools", () => {
	it("routes passive inspection and browse without a lifecycle mutation", async () => {
		expect(await manageDocument("grasshopper", { action: "list" })).toEqual({ type: "listGrasshopperDocuments" });
		expect(await manageDocument("rhino", { action: "getSettings", documentId: "rh-1" })).toEqual({ type: "getRhinoDocumentSettings", documentId: "rh-1" });
		expect(await manageDocument("grasshopper", { action: "browse", path: "C:\\Models", limit: 5 })).toMatchObject({ type: "browseDocumentFiles", kind: "grasshopper", path: "C:\\Models", limit: 5 });
	});
	it("preserves explicit null and revision checks on open", async () => {
		expect(await manageDocument("rhino", { action: "open", path: "/Models/日本語 model.3dm", expectedActiveDocument: null, affectedDocuments: [] })).toMatchObject({ type: "manageRhinoDocument", expectedActiveDocument: null, affectedDocuments: [] });
	});
	it("rejects missing observations before dispatch", () => {
		expect(() => validateDocumentRequest("rhino", { action: "open", path: "/a.3dm", affectedDocuments: [] })).toThrow("expectedActiveDocument");
		expect(() => validateDocumentRequest("rhino", { action: "new", expectedActiveDocument: null })).toThrow("affectedDocuments");
		expect(() => validateDocumentRequest("rhino", { action: "close", documentId: "rh-1", onUnsaved: "discard" })).toThrow("expectedStateToken");
		expect(() => validateDocumentRequest("rhino", { action: "close", documentId: "rh-1", expectedStateToken: "v1" })).toThrow("onUnsaved");
	});
	it("rejects relative paths, foreign file formats, and malformed affected documents", () => {
		expect(() => validateDocumentRequest("grasshopper", { action: "browse", path: "models" })).toThrow("absolute");
		expect(() => validateDocumentRequest("grasshopper", { action: "saveAs", documentId: "gh-1", expectedStateToken: "1", path: "/a.3dm" })).toThrow("extension");
		expect(() => validateDocumentRequest("rhino", { action: "new", expectedActiveDocument: "rh-1", affectedDocuments: [{ documentId: "rh-1", expectedStateToken: "", onUnsaved: "discard" }] })).toThrow("expectedStateToken");
	});
});
