// @vitest-environment happy-dom
import { act, createElement, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./app";
import { createHopperStore } from "./state/hopper-store";
import type { HopperStore } from "./state/hopper-types";
import { HopperStoreProvider } from "./state/hopper-store-context";
import { mockRuntimeStatus } from "./mocks/hopper-mock";
import type { PromptReceipt } from "./hooks/use-hopper-connection";
import type { DraftImage } from "./lib/image-attachments";

const renders = vi.hoisted(() => ({ app: vi.fn(), sidebar: vi.fn(), models: vi.fn(), conversation: vi.fn(), prompt: vi.fn<(...args: unknown[]) => boolean>(() => true) }));

vi.mock("./hooks/use-hopper-connection", () => ({
	useHopperConnection: () => {
		renders.app();
		return { token: "test", send: () => true, prompt: renders.prompt, login: () => true, logout: () => true, reconnect: () => {}, isMockMode: false };
	},
}));
// Drive polling results explicitly so each render assertion covers one update.
vi.mock("./hooks/use-runtime-status", () => ({ useRuntimeStatus: () => ({ refresh: async () => {}, refreshing: false }) }));
vi.mock("./components/sidebar", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./components/sidebar")>();
	return { ...actual, Sidebar: (props: Parameters<typeof actual.Sidebar>[0]) =>
		createElement(Profiler, { id: "sidebar", onRender: renders.sidebar }, createElement(actual.Sidebar, props)) };
});
vi.mock("./lib/image-attachments", async (load) => ({
	...await load<typeof import("./lib/image-attachments")>(),
	readImage: async () => ({ id: "draft-image", name: "plan.png", width: 800, height: 500,
		image: { type: "image", mimeType: "image/png", data: "bWFya2Vk" },
		original: { type: "image", mimeType: "image/png", data: "cGxhbg==" },
		scene: { elements: [], files: {}, appState: { currentItemStrokeColor: "red" } },
	}),
}));
vi.mock("./components/image-annotation-dialog", () => ({
	ImageAnnotationDialog: ({ attachment }: { attachment: DraftImage }) => createElement("div", { role: "dialog" },
		attachment.scene?.appState.currentItemStrokeColor === "red" ? "Editable annotations restored" : "Missing annotations"),
}));
vi.mock("./components/model-picker", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./components/model-picker")>();
	return { ...actual, ModelControls: (props: Parameters<typeof actual.ModelControls>[0]) =>
		createElement(Profiler, { id: "models", onRender: renders.models }, createElement(actual.ModelControls, props)) };
});
vi.mock("./components/conversation", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./components/conversation")>();
	return { ...actual, Conversation: (props: Parameters<typeof actual.Conversation>[0]) =>
		createElement(Profiler, { id: "conversation", onRender: renders.conversation }, createElement(actual.Conversation, props)) };
});

let root: Root;
let container: HTMLDivElement;
let store: HopperStore;
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	store = createHopperStore();
	store.getState().actions.applySnapshot({
		sessionId: "session-1", messages: [], isStreaming: true, thinkingLevel: "off", availableThinkingLevels: ["off"],
		models: [{ provider: "openai", id: "test-model", name: "Test model" }], model: { provider: "openai", id: "test-model" },
		providers: [{ id: "openai", name: "OpenAI", authenticated: true, authMethods: [{ type: "api_key", label: "API key" }] }],
		streamingMessage: { id: "assistant-1", role: "assistant", content: [{ type: "text", text: "Checking " }] },
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root.render(createElement(HopperStoreProvider, { store, children: createElement(App) })));
	vi.clearAllMocks();
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

it("streams text without rerendering the app, sidebar, or model controls", async () => {
	await act(async () => store.getState().actions.applyAgentEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "the canvas." } }));
	expect(container.textContent).toContain("Checking the canvas.");
	expect(renders.conversation).toHaveBeenCalled();
	expect(renders.app).not.toHaveBeenCalled();
	expect(renders.sidebar).not.toHaveBeenCalled();
	expect(renders.models).not.toHaveBeenCalled();
});

it("updates runtime controls without rerendering the conversation or app", async () => {
	await act(async () => store.getState().actions.setRuntimeStatus(mockRuntimeStatus));
	expect(renders.sidebar).toHaveBeenCalled();
	expect(renders.app).not.toHaveBeenCalled();
	expect(renders.conversation).not.toHaveBeenCalled();
	expect(renders.models).not.toHaveBeenCalled();
});

it("shows notifications and queued input without rerendering the app or conversation", async () => {
	await act(async () => store.getState().actions.toast("Canvas updated"));
	expect(document.body.textContent).toContain("Canvas updated");
	await act(async () => store.getState().actions.queueUiRequest({ requestId: "confirm-1", kind: "confirm", title: "Apply the graph?" }));
	expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Apply the graph?");
	expect(renders.app).not.toHaveBeenCalled();
	expect(renders.conversation).not.toHaveBeenCalled();
	expect(renders.sidebar).not.toHaveBeenCalled();
	expect(renders.models).not.toHaveBeenCalled();
});

async function submitAnnotatedDraft() {
	const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
	Object.defineProperty(input, "files", { value: [new File(["image"], "plan.png", { type: "image/png" })] });
	await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
	await act(async () => {
		const textarea = container.querySelector("textarea")!;
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Inspect the marked area");
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click());
	return renders.prompt.mock.calls.at(-1)![3] as PromptReceipt;
}

it("retains text and editable annotations after a rejected submission and snapshot", async () => {
	const receipt = await submitAnnotatedDraft();
	expect(container.querySelector("textarea")!.disabled).toBe(true);
	expect(container.querySelector("img")!.src).toContain("bWFya2Vk");
	await act(async () => {
		receipt.onRejected();
		store.getState().actions.applySnapshot({ sessionId: "session-1", messages: [], isStreaming: false,
			thinkingLevel: "off", availableThinkingLevels: [], models: [], providers: [] });
	});
	expect(container.querySelector("textarea")!.value).toBe("Inspect the marked area");
	expect(container.querySelector("textarea")!.disabled).toBe(false);
	await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Annotate plan.png"]')!.click());
	expect(container.textContent).toContain("Editable annotations restored");
});

it("clears a draft only after acceptance and ignores late receipts from previous submissions", async () => {
	const first = await submitAnnotatedDraft();
	await act(async () => first.onRejected());
	await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click());
	const second = renders.prompt.mock.calls.at(-1)![3] as PromptReceipt;
	await act(async () => first.onAccepted());
	expect(container.querySelector("img")).not.toBeNull();
	await act(async () => second.onAccepted());
	expect(container.querySelector("img")).toBeNull();
	expect(container.querySelector("textarea")!.value).toBe("");
});
