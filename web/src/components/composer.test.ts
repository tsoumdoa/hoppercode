// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Composer } from "./composer";
import type { DraftImage } from "../lib/image-attachments";

const source: DraftImage = {
	id: "image-1", name: "plan.png", width: 800, height: 500,
	image: { type: "image", mimeType: "image/png", data: "cGxhbg==" },
	original: { type: "image", mimeType: "image/png", data: "cGxhbg==" },
};
const submit = vi.fn();
vi.mock("./image-annotation-dialog", () => ({
	ImageAnnotationDialog: ({ attachment, onSave, onClose }: { attachment?: DraftImage; onSave(image: DraftImage): void; onClose(): void }) => createElement("div", { role: "dialog" },
		createElement("p", null, attachment?.scene ? "Existing annotations" : attachment ? "New annotations" : "Blank canvas"),
		createElement("button", { onClick: onClose }, "Cancel"),
		createElement("button", { onClick: () => onSave({
			...(attachment ?? { id: "drawing-1", name: "Drawing.png" }),
			image: { type: "image", mimeType: "image/png", data: "bWFya2Vk" },
			scene: { elements: [], files: {}, appState: {} },
		}) }, attachment?.original ? "Save annotations" : "Save drawing"),
	),
}));
vi.mock("../lib/image-attachments", async (original) => ({
	...await original<typeof import("../lib/image-attachments")>(),
	readImage: async (file: File) => {
		if (file.type !== "image/png") throw new Error("Use PNG, JPEG, WebP, or GIF images.");
		return { ...source, id: file.name, name: file.name };
	},
}));
let root: Root;
let container: HTMLDivElement;
function Harness({ supported = true, initial = [source] }: { supported?: boolean; initial?: DraftImage[] }) {
	const [images, setImages] = useState(initial);
	return createElement(Composer, {
		draft: "", images, onImagesChange: setImages, imagesSupported: supported, onDraftChange: () => {},
		mode: "prompt", onModeChange: () => {}, disabled: false, streaming: false,
		onSubmit: () => submit(images), onAbort: () => {},
	});
}
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const byText = (text: string) => [...container.querySelectorAll('button')].find((node) => node.textContent === text)!;
async function upload(name: string, type = "image/png") {
	const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
	Object.defineProperty(input, "files", { configurable: true, value: [new File(["test"], name, { type })] });
	await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div"); document.body.append(container); root = createRoot(container); submit.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("cancels without changing the attachment, saves, then reopens editable annotations", async () => {
	await act(async () => root.render(createElement(Harness)));
	await act(async () => button("Annotate plan.png").click());
	await act(async () => byText("Cancel").click());
	expect(container.querySelector("img")!.src).toContain(source.image.data);
	await act(async () => button("Annotate plan.png").click());
	await act(async () => byText("Save annotations").click());
	expect(container.querySelector("img")!.src).toContain("bWFya2Vk");
	await act(async () => button("Annotate plan.png").click());
	expect(container.textContent).toContain("Existing annotations");
	await act(async () => byText("Cancel").click());
	await act(async () => button("Send message").click());
	expect(submit.mock.calls[0][0][0].image.data).toBe("bWFya2Vk");
});

it("replaces an image without keeping its annotations, and removes attachments", async () => {
	await act(async () => root.render(createElement(Harness)));
	await act(async () => button("Annotate plan.png").click());
	await act(async () => byText("Save annotations").click());
	await act(async () => button("Replace plan.png").click());
	await upload("replacement.png");
	expect(container.querySelectorAll("img")).toHaveLength(1);
	await act(async () => button("Annotate replacement.png").click());
	expect(container.textContent).toContain("New annotations");
	await act(async () => byText("Cancel").click());
	await act(async () => button("Remove replacement.png").click());
	expect(container.querySelectorAll("img")).toHaveLength(0);
	expect(button("Send message").disabled).toBe(true);
});

it("keeps the existing attachment when replacement fails", async () => {
	await act(async () => root.render(createElement(Harness)));
	await act(async () => button("Replace plan.png").click());
	await upload("bad.svg", "image/svg+xml");
	expect(container.querySelector('[role="alert"]')?.textContent).toContain("Use PNG");
	expect(container.querySelector("img")!.alt).toBe("plan.png");
});

it("blocks image submission for text-only models and allows removing the image", async () => {
	await act(async () => root.render(createElement(Harness, { supported: false })));
	expect(button("Send message").disabled).toBe(true);
	expect(container.querySelector('[role="alert"]')?.textContent).toContain("supports images");
	await act(async () => button("Remove plan.png").click());
	expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("creates a standalone drawing, reopens it for editing, and sends it without text", async () => {
	await act(async () => root.render(createElement(Harness, { initial: [] })));
	await act(async () => button("New drawing").click());
	expect(container.textContent).toContain("Blank canvas");
	expect(container.querySelector("img")).toBeNull();
	await act(async () => byText("Cancel").click());
	expect(container.querySelector("img")).toBeNull();
	expect(button("Send message").disabled).toBe(true);
	await act(async () => button("New drawing").click());
	await act(async () => byText("Save drawing").click());
	expect(container.querySelectorAll("img")).toHaveLength(1);
	await act(async () => button("Annotate Drawing.png").click());
	expect(container.textContent).toContain("Existing annotations");
	await act(async () => byText("Save drawing").click());
	expect(container.querySelectorAll("img")).toHaveLength(1);
	await act(async () => button("Send message").click());
	const [drawing] = submit.mock.calls[0][0] as DraftImage[];
	expect(drawing.image).toMatchObject({ mimeType: "image/png", data: "bWFya2Vk" });
	expect(drawing.original).toBeUndefined();
	expect(drawing.scene).toBeDefined();
});

it("counts new drawings toward the shared four-attachment limit", async () => {
	await act(async () => root.render(createElement(Harness, {
		initial: [source, { ...source, id: "image-2" }, { ...source, id: "image-3" }],
	})));
	await act(async () => button("New drawing").click());
	await act(async () => byText("Save drawing").click());
	expect(container.querySelectorAll("img")).toHaveLength(4);
	expect(button("New drawing").disabled).toBe(true);
	expect(button("Attach images").disabled).toBe(true);
	await act(async () => button("Remove Drawing.png").click());
	expect(button("New drawing").disabled).toBe(false);
});
