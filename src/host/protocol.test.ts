import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, parseClientMessage } from "./protocol.js";

describe("browser protocol", () => {
	it("parses supported messages", () => {
		expect(parseClientMessage('{"type":"prompt","text":"make a loft"}'))
			.toEqual({ type: "prompt", text: "make a loft" });
		expect(parseClientMessage('{"type":"login","provider":"anthropic","authType":"api_key"}'))
			.toEqual({ type: "login", provider: "anthropic", authType: "api_key" });
		expect(parseClientMessage('{"type":"set_model","provider":"anthropic","modelId":"opus"}'))
			.toEqual({ type: "set_model", provider: "anthropic", id: "opus" });
		expect(parseClientMessage('{"type":"ui_response","requestId":"r1","result":false,"cancelled":false}'))
			.toEqual({ type: "ui_response", requestId: "r1", value: false });
	});

	it("rejects malformed and unknown messages", () => {
		expect(() => parseClientMessage("no")) .toThrow("valid JSON");
		expect(() => parseClientMessage('{"type":"prompt","text":""}')).toThrow("non-empty string");
		expect(() => parseClientMessage('{"type":"wat"}')).toThrow("Unknown message type");
	});
});

const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
it.each(["prompt", "steer", "follow_up"])("accepts image-only %s messages and strips untrusted fields", (type) => {
	expect(parseClientMessage(JSON.stringify({ type, text: "", images: [{ ...image, url: "https://example.com" }] }))).toEqual({ type, text: "", images: [image] });
});
it.each([
	["unsupported format", [{ ...image, mimeType: "image/svg+xml" }]],
	["invalid base64", [{ ...image, data: "not base64" }]],
	["empty image", [{ ...image, data: "" }]],
	["oversized image", [{ ...image, data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64") }]],
	["too many images", Array(5).fill(image)],
	["invalid shape", "images"],
])("rejects %s", (_label, images) => {
	expect(() => parseClientMessage(JSON.stringify({ type: "prompt", text: "Inspect", images }))).toThrow();
});
