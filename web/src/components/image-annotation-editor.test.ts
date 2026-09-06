// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExcalidrawImperativeAPI, ExcalidrawProps } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { DraftImage } from "../lib/image-attachments";
import ImageAnnotationEditor from "./image-annotation-editor";
import { MAX_IMAGE_BYTES, parseImages } from "../../../src/host/protocol";

const editor = vi.hoisted(() => ({ props: {} as ExcalidrawProps, api: {} as ExcalidrawImperativeAPI, exportBlob: vi.fn() }));
vi.mock("@excalidraw/excalidraw", () => ({
	Excalidraw: (props: ExcalidrawProps) => {
		editor.props = props;
		useEffect(() => { props.excalidrawAPI?.(editor.api); }, []);
		return null;
	},
	MainMenu: Object.assign(() => null, { DefaultItems: { ClearCanvas: () => null, ChangeCanvasBackground: () => null } }),
	CaptureUpdateAction: { IMMEDIATELY: "IMMEDIATELY" },
	convertToExcalidrawElements: (elements: object[]) => elements.map((element, index) => ({ id: `element-${index}`, opacity: 100, ...element })),
	newElementWith: (element: ExcalidrawElement, updates: object) => ({ ...element, ...updates }),
	exportToBlob: editor.exportBlob,
}));

const attachment: DraftImage = {
	id: "source-file", name: "plan.png", width: 800, height: 500,
	image: { type: "image", mimeType: "image/png", data: "cGxhbg==" },
	original: { type: "image", mimeType: "image/png", data: "cGxhbg==" },
};
let elements: readonly ExcalidrawElement[];
let root: Root;
let container: HTMLDivElement;
const save = vi.fn();
const cancel = vi.fn();
const slider = () => container.querySelector<HTMLInputElement>('input[type="range"]')!;
const click = async (label: string) => act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === label)!.click());
type SceneChange = Parameters<NonNullable<ExcalidrawProps["onChange"]>>;
const notify = () => editor.props.onChange?.(elements as SceneChange[0], { isLoading: true } as SceneChange[1], {});
async function render(image: DraftImage | null = attachment) {
	await act(async () => root.render(createElement(ImageAnnotationEditor, { attachment: image ?? undefined, onSave: save, onCancel: cancel })));
	const initial = editor.props.initialData as { elements: readonly ExcalidrawElement[] };
	elements = initial.elements;
}
async function opacity(value: number) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider(), String(value));
		slider().dispatchEvent(new Event("input", { bubbles: true }));
	});
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div"); document.body.append(container); root = createRoot(container);
	save.mockReset(); cancel.mockReset();
	editor.exportBlob.mockReset().mockResolvedValue(new Blob(["saved"], { type: "image/png" }));
	editor.api = {
		getSceneElements: () => elements.filter((element) => !element.isDeleted),
		getSceneElementsIncludingDeleted: () => elements,
		getFiles: () => ({}), getAppState: () => ({}),
		scrollToContent: vi.fn(),
		updateScene: vi.fn((update) => { elements = update.elements!; notify(); }),
	} as unknown as ExcalidrawImperativeAPI;
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("changes only the source image, exports zero opacity, and restores it on reopen", async () => {
	await render();
	const mark = { id: "arrow", type: "arrow", opacity: 100 } as ExcalidrawElement;
	const deleted = { id: "deleted", type: "rectangle", opacity: 100, isDeleted: true } as ExcalidrawElement;
	elements = [...elements, mark, deleted];
	await opacity(0);
	expect(elements[0]).toMatchObject({ locked: true, opacity: 0 });
	expect(elements[1]).toBe(mark);
	expect(elements[2]).toBe(deleted);
	expect(editor.api.updateScene).toHaveBeenCalledWith(expect.objectContaining({ captureUpdate: "IMMEDIATELY" }));
	expect(slider().value).toBe("0");
	await click("Save annotations");
	await act(async () => { await vi.waitFor(() => expect(save).toHaveBeenCalledOnce()); });
	expect(editor.exportBlob).toHaveBeenCalledWith(expect.objectContaining({ elements: [expect.objectContaining({ opacity: 0 }), mark] }));
	const saved = save.mock.calls[0][0] as DraftImage;
	expect(saved.scene?.elements[0].opacity).toBe(0);
	expect(saved.original).toEqual(attachment.original);
	await act(async () => root.unmount());
	root = createRoot(container);
	await render(saved);
	expect(slider().value).toBe("0");
	await opacity(65);
	await click("Cancel");
	expect(cancel).toHaveBeenCalledOnce();
	expect(saved.scene?.elements[0].opacity).toBe(0);
	expect(save).toHaveBeenCalledOnce();
});

it("tracks scene undo and deletion without restoring deleted elements", async () => {
	await render();
	await opacity(40);
	await act(async () => { elements = elements.map((element) => ({ ...element, opacity: 100 })); notify(); });
	expect(slider().value).toBe("100");
	await act(async () => { elements = elements.map((element) => ({ ...element, isDeleted: true })); notify(); });
	expect(slider().disabled).toBe(true);
	await act(async () => { elements = elements.map((element) => ({ ...element, isDeleted: false, opacity: 40 })); notify(); });
	expect(slider().disabled).toBe(false);
	expect(slider().value).toBe("40");
});

it("reduces oversized PNG exports until they pass host validation, preserving the editable scene", async () => {
	await render();
	await opacity(45);
	const originalElements = elements;
	editor.exportBlob.mockImplementation(async ({ maxWidthOrHeight }: { maxWidthOrHeight: number }) =>
		new Blob([new Uint8Array(maxWidthOrHeight > 1200 ? 7_684_527 : MAX_IMAGE_BYTES)], { type: "image/png" }));
	await click("Save annotations");
	await act(async () => { await vi.waitFor(() => expect(save).toHaveBeenCalledOnce()); });
	expect(editor.exportBlob.mock.calls.map(([options]) => options.maxWidthOrHeight)).toEqual([2048, 1536, 1152]);
	const saved = save.mock.calls[0][0] as DraftImage;
	expect(parseImages([saved.image])).toEqual([saved.image]);
	expect(saved.scene?.elements).toEqual(originalElements);
	expect(saved.original).toEqual(attachment.original);
});

it("bounds failed export retries and keeps the editor available", async () => {
	await render();
	editor.exportBlob.mockResolvedValue(new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)], { type: "image/png" }));
	await click("Save annotations");
	await act(async () => { await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("drawing is still open")); });
	expect(editor.exportBlob.mock.calls.at(-1)![0].maxWidthOrHeight).toBe(128);
	expect(editor.exportBlob.mock.calls.length).toBeLessThan(12);
	expect(save).not.toHaveBeenCalled();
	expect(slider().disabled).toBe(false);
});

it("starts an empty freehand canvas, rejects empty saves, and reopens the drawing without a background image", async () => {
	await render(null);
	expect(editor.props.initialData).toMatchObject({ elements: [], files: {}, appState: { activeTool: { type: "freedraw" } } });
	expect(slider()).toBeNull();
	await click("Save drawing");
	expect(container.querySelector('[role="alert"]')?.textContent).toContain("Draw something");
	expect(editor.exportBlob).not.toHaveBeenCalled();
	const stroke = { id: "stroke", type: "freedraw", opacity: 100, points: [[0, 0], [100, 80]] } as unknown as ExcalidrawElement;
	const scheduleFrame = vi.fn();
	vi.stubGlobal("requestAnimationFrame", scheduleFrame);
	await act(async () => {
		elements = [stroke];
		editor.props.onChange?.(elements as SceneChange[0], { isLoading: false } as SceneChange[1], {});
	});
	expect(scheduleFrame).not.toHaveBeenCalled();
	expect(editor.api.scrollToContent).not.toHaveBeenCalled();
	await click("Save drawing");
	await act(async () => { await vi.waitFor(() => expect(save).toHaveBeenCalledOnce()); });
	const drawing = save.mock.calls[0][0] as DraftImage;
	expect(drawing).toMatchObject({ name: "Drawing.png", image: { mimeType: "image/png" }, scene: { elements: [stroke] } });
	expect(drawing.original).toBeUndefined();
	await act(async () => root.unmount());
	root = createRoot(container);
	await render(drawing);
	expect(elements).toEqual([stroke]);
	expect(slider()).toBeNull();
	await click("Save drawing");
	await act(async () => { await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2)); });
	expect(save.mock.calls[1][0].id).toBe(drawing.id);
});
