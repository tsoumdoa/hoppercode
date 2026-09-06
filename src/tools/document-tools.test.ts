import { describe, expect, it, vi } from "vitest";
const { manageDocument } = vi.hoisted(() => ({ manageDocument: vi.fn() }));
vi.mock("../services/document-management.js", () => ({ manageDocument }));
import { createDocumentTool } from "./document-tools.js";

describe("document tool result handling", () => {
	it("marks native domain failures as errors and preserves completed side effects", async () => {
		const partial = { ok: false, error: { code: "CLOSE_FAILED", message: "Native close failed" }, effects: [{ stage: "save", completed: true, path: "/a.gh" }] };
		manageDocument.mockResolvedValueOnce(partial);
		const result = await createDocumentTool("grasshopper").execute("call-1", { action: "close", documentId: "gh-1", expectedStateToken: "v1", onUnsaved: "save" }, undefined, undefined, {} as never);
		expect(result).toMatchObject({ isError: true });
		const content = result.content[0];
		expect(content.type).toBe("text");
		if (content.type === "text") expect(JSON.parse(content.text)).toEqual(partial);
	});
});
