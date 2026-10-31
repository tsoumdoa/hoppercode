// @vitest-environment happy-dom
import { Storage } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./app";
import { HopperStoreProvider } from "./state/hopper-store-context";
vi.mock("./hooks/use-runtime-status", () => ({
	useRuntimeStatus: () => ({ refresh: async () => {}, refreshing: false }),
}));
vi.mock("./components/image-annotation-dialog", () => ({
	ImageAnnotationDialog: () => null,
}));
vi.mock("./lib/image-attachments", async (load) => ({
	...(await load<typeof import("./lib/image-attachments")>()),
	readImage: async (file: File) => ({
		id: file.name,
		name: file.name,
		width: 10,
		height: 10,
		image: { type: "image", mimeType: "image/png", data: btoa(file.name) },
		original: { type: "image", mimeType: "image/png", data: btoa(file.name) },
	}),
}));
class Socket {
	static OPEN = 1;
	static sockets: Socket[] = [];
	readyState = 1;
	sent: any[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	constructor(readonly url: string | URL) {
		Socket.sockets.push(this);
	}
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {}
	receive(data: unknown) {
		this.onmessage?.({ data: JSON.stringify(data) });
	}
}
const binding = {
	kind: "rhino",
	lifecycleInstanceId: "life",
	rhinoDocumentId: "model",
};
const snapshot = {
	hostEpoch: "epoch",
	conversationSession: { id: "rhino-session", afterConversationSequence: 0 },
	conversations: [
		{ id: "conversation", title: "First", sequence: 1 },
		{ id: "other", title: "Second", sequence: 2 },
	],
	sessions: [
		{ id: "session", conversation_id: "conversation" },
		{ id: "other-session", conversation_id: "other" },
	],
	tasks: [],
	turns: [],
	events: [],
	recoveries: [],
	questions: [],
	targets: [
		{
			label: "Rhino",
			lifecycleInstanceId: "life",
			processId: 42,
			admission: "ready",
			documents: [binding],
			documentLabels: { model: "Facade.3dm" },
		},
	],
	runtime: {
		sessionId: "session", isStreaming: false,
		messages: [],
		thinkingLevel: "off",
		availableThinkingLevels: ["off"],
		model: { provider: "test", id: "test" },
		models: [{ provider: "test", id: "test", input: ["text", "image"] }],
		providers: [],
	},
	eventCursor: 0,
};
let root: Root, container: HTMLDivElement, socket: Socket;
const byText = (text: string) =>
	[...container.querySelectorAll("button")].find(
		(button) => button.textContent === text,
	)!;
const sendButton = () =>
	container.querySelector<HTMLButtonElement>(
		'button[aria-label="Send message"]',
	)!;
async function value(selector: string, text: string) {
	const input = document.querySelector<
		HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
	>(selector)!;
	await act(async () => {
		const prototype =
			input instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: input instanceof HTMLSelectElement
					? HTMLSelectElement.prototype
					: HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, text);
		input.dispatchEvent(
			new Event(input instanceof HTMLSelectElement ? "change" : "input", {
				bubbles: true,
			}),
		);
	});
}
async function upload(name: string) {
	const input =
		container.querySelector<HTMLInputElement>('input[type="file"]')!;
	Object.defineProperty(input, "files", {
		configurable: true,
		value: [new File(["image"], name, { type: "image/png" })],
	});
	await act(async () =>
		input.dispatchEvent(new Event("change", { bubbles: true })),
	);
}
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("WebSocket", Socket);
	// Remote HTTP previews have getRandomValues but no randomUUID.
	vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
	Socket.sockets = [];
	history.replaceState(null, "", "/#credential");
	sessionStorage.clear();
	vi.stubGlobal("localStorage", new Storage());
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root.render(
			createElement(HopperStoreProvider, { children: createElement(App) }),
		),
	);
	socket = Socket.sockets[0]!;
	await act(async () => {
		socket.onopen?.();
		socket.receive({ type: "shared_snapshot", snapshot: { ...snapshot, conversations: [], sessions: [] } });
	});
	expect(container.querySelector("h1")!.textContent).toBe("New chat");
	const startup = socket.sent.find((command) => command.type === "create_conversation");
	expect(startup.title).toBe("New chat");
	await act(async () => socket.receive({
		type: "command_accepted", requestId: startup.requestId,
		result: { conversationId: "conversation" },
	}));
	await act(async () => socket.receive({ type: "shared_snapshot", snapshot }));
	socket.sent = [];
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
it("sends image-only input with the existing image limit and retains it on rejection", async () => {
	await upload("plan.png");
	expect(container.querySelectorAll("img")).toHaveLength(1);
	await act(async () => sendButton().click());
	const command = socket.sent.find((command) => command.type === "submit");
	expect(command.text).toBe("");
	expect(command.attachments).toEqual([
		{ type: "image", mimeType: "image/png", data: btoa("plan.png") },
	]);
	expect(sendButton().disabled).toBe(true);
	await act(async () =>
		socket.receive({
			type: "error",
			requestId: command.requestId,
			message: "Not accepted",
		}),
	);
	expect(container.querySelectorAll("img")).toHaveLength(1);
	expect(sendButton().disabled).toBe(false);
});

it("stops the active task before queued follow-ups and disables Stop while disconnected", async () => {
	const queued = { id: "queued-task", conversation_id: "conversation", parent_task_id: null, state: "queued", payload: JSON.stringify({ text: "Follow-up", bindings: [binding] }) };
	const running = { ...queued, id: "running-task", state: "running" };
	await act(async () => socket.receive({ type: "shared_snapshot", snapshot: { ...snapshot, tasks: [queued, running] } }));
	const stop = container.querySelector<HTMLButtonElement>('footer button[aria-label="Stop"]')!;
	await act(async () => stop.click());
	expect(socket.sent.find(command => command.type === "cancel")).toMatchObject({ taskId: running.id });
	await act(async () => socket.onclose?.({ code: 4001, reason: "Replaced by another tab" }));
	expect(stop.disabled).toBe(true);
});

it("reconnects to the same shared endpoint and retries a captured multi-target command once", async () => {
	vi.useFakeTimers();
	const second = { ...binding, lifecycleInstanceId: "life-2", rhinoDocumentId: "other-model" };
	await act(async () => socket.receive({ type: "shared_snapshot", snapshot: { ...snapshot, targets: [...snapshot.targets, { ...snapshot.targets[0], lifecycleInstanceId: "life-2", processId: 43, documents: [second] }] } }));
	await value("#composer-input", "Compare these models");
	await act(async () => sendButton().click());
	const submitted = socket.sent.find((command) => command.type === "submit");
	expect(submitted.bindings).toEqual([binding, second]);
	await act(async () => socket.onclose?.({ code: 1006, reason: "Network lost" }));
	await act(async () => vi.advanceTimersByTimeAsync(1500));
	const replacement = Socket.sockets.at(-1)!;
	expect(replacement.url.toString()).toBe(socket.url.toString());
	expect(replacement.url.toString()).toContain("/ws-shared");
	await act(async () => { replacement.onopen?.(); replacement.receive({ type: "shared_snapshot", snapshot: { ...snapshot, hostEpoch: "replacement-host" } }); });
	expect(replacement.sent.filter((command) => command.type === "submit")).toEqual([submitted]);
	expect(replacement.sent.filter((command) => command.type === "create_conversation")).toEqual([]);
	expect(replacement.sent[0]).toEqual({ type: "authenticate", token: "credential" });
	await act(async () => replacement.receive({ type: "shared_snapshot", snapshot }));
	expect(replacement.sent.filter((command) => command.type === "submit")).toHaveLength(1);
	await act(async () => replacement.receive({ type: "command_accepted", requestId: submitted.requestId, result: { taskId: "task" } }));
	expect(container.querySelector<HTMLTextAreaElement>("#composer-input")!.value).toBe("");
});

it("ignores late messages, acknowledgements and opens from the replaced socket", async () => {
	await value("#composer-input", "Keep this draft");
	await act(async () => sendButton().click());
	const submitted = socket.sent.find((command) => command.type === "submit");
	await act(async () => socket.onclose?.({ code: 1006, reason: "Lost" }));
	await act(async () => byText("Retry").click());
	const sent = socket.sent.length;
	await act(async () => {
		socket.onopen?.();
		socket.receive({ type: "command_accepted", requestId: submitted.requestId, result: { taskId: "task" } });
		socket.receive({ type: "shared_snapshot", snapshot });
	});
	expect(socket.sent).toHaveLength(sent);
	expect(container.querySelector<HTMLTextAreaElement>("#composer-input")!.readOnly).toBe(true);
	expect(container.querySelector<HTMLTextAreaElement>("#composer-input")!.value).toBe("Keep this draft");
	const replacement = Socket.sockets.at(-1)!;
	await act(async () => { replacement.onopen?.(); replacement.receive({ type: "shared_snapshot", snapshot }); });
	expect(replacement.sent).toContainEqual(submitted);
});

it("recovers a silently dead connection after wake and keeps the draft", async () => {
	vi.useFakeTimers();
	await act(async () => socket.onclose?.({ code: 1006, reason: "Lost" }));
	await act(async () => window.dispatchEvent(new Event("online")));
	const replacement = Socket.sockets.at(-1)!;
	await act(async () => { replacement.onopen?.(); replacement.receive({ type: "shared_snapshot", snapshot }); });
	await value("#composer-input", "Preserved after sleep");
	replacement.sent = [];
	await act(async () => window.dispatchEvent(new Event("pageshow")));
	expect(replacement.sent).toEqual([{ type: "snapshot", conversationId: "conversation" }]);
	await act(async () => vi.advanceTimersByTimeAsync(10_000));
	expect(container.querySelector<HTMLTextAreaElement>("#composer-input")!.readOnly).toBe(true);
	await act(async () => vi.advanceTimersByTimeAsync(1500));
	expect(Socket.sockets).toHaveLength(3);
	expect(container.querySelector<HTMLTextAreaElement>("#composer-input")!.value).toBe("Preserved after sleep");
});

it("retains a durable command when WebSocket.send throws and retries the same request", async () => {
	vi.useFakeTimers();
	await value("#composer-input", "Keep the request");
	const original = socket.send.bind(socket);
	socket.send = (data) => { original(data); throw new Error("Socket closed"); };
	await act(async () => sendButton().click());
	const command = socket.sent.find((command) => command.type === "submit");
	await act(async () => vi.advanceTimersByTimeAsync(1500));
	const replacement = Socket.sockets.at(-1)!;
	expect(replacement).not.toBe(socket);
	await act(async () => { replacement.onopen?.(); replacement.receive({ type: "shared_snapshot", snapshot }); });
	expect(replacement.sent.filter((command) => command.type === "submit")).toEqual([command]);
	expect(container.querySelector<HTMLTextAreaElement>("#composer-input")!.value).toBe("Keep the request");
});

it("keeps drafts in their thread when hopping to a globally live thread and back", async () => {
	await value("#composer-input", "Draft for the first thread");
	const secondBinding = { ...binding, rhinoDocumentId: "second-model" };
	const next = {
		...snapshot,
		targets: [{ ...snapshot.targets[0], documents: [binding, secondBinding] }],
		conversations: [
			snapshot.conversations[0],
			{ ...snapshot.conversations[1], live_state: "awaiting_user", last_message_target: JSON.stringify(secondBinding) },
		],
	};
	await act(async () =>
		socket.receive({ type: "shared_snapshot", snapshot: next }),
	);
	await act(async () => byText("Jump back").click());
	expect(
		container.querySelector<HTMLTextAreaElement>("#composer-input")!.value,
	).toBe("");
	await value("#composer-input", "Draft for the second thread");
	await act(async () => socket.receive({ type: "shared_snapshot", snapshot: { ...next, conversations: next.conversations.map(row => ({ ...row, live_state: null })) } }));
	await act(async () => sendButton().click());
	expect(socket.sent.find(command => command.type === "submit")).toMatchObject({ text: "Draft for the second thread", messageTarget: secondBinding });
	socket.sent = [];
	const first = container.querySelector<HTMLButtonElement>(
		'nav[aria-label="Thread history"] button[title="First"]',
	)!;
	await act(async () => first.click());
	expect(
		container.querySelector<HTMLTextAreaElement>("#composer-input")!.value,
	).toBe("Draft for the first thread");
	// Losing A must not silently redirect its draft to the remaining document B.
	await act(async () => socket.receive({ type: "shared_snapshot", snapshot: { ...snapshot, targets: [{ ...snapshot.targets[0], documents: [secondBinding] }] } }));
	expect(sendButton().disabled).toBe(true);
	await act(async () => socket.receive({ type: "shared_snapshot", snapshot }));
	await act(async () => sendButton().click());
	expect(socket.sent.find(command => command.type === "submit")).toMatchObject({ text: "Draft for the first thread", messageTarget: binding });
});

it("acknowledges a submission in its original thread without clearing newer text", async () => {
	await value("#composer-input", "Original request");
	await upload("original.png");
	await act(async () => sendButton().click());
	const submitted = socket.sent.find(command => command.type === "submit");
	await value("#composer-input", "Newer draft");
	const thread = (title: string) => container.querySelector<HTMLButtonElement>(`nav[aria-label="Thread history"] button[title="${title}"]`)!;
	await act(async () => thread("Second").click());
	await value("#composer-input", "Other thread draft");
	await act(async () => socket.receive({ type: "command_accepted", requestId: submitted.requestId, result: { taskId: "task" } }));
	expect(container.querySelector<HTMLTextAreaElement>("#composer-input")!.value).toBe("Other thread draft");
	await act(async () => thread("First").click());
	expect(container.querySelector<HTMLTextAreaElement>("#composer-input")!.value).toBe("Newer draft");
	expect(container.querySelectorAll("img")).toHaveLength(0);
	await act(async () => sendButton().click());
	expect(socket.sent.filter(command => command.type === "submit").at(-1)).toMatchObject({
		text: "Newer draft", attachments: [],
	});
});

it("starts fresh after a conversation session reset and ignores acknowledgements from the old session", async () => {
	vi.useFakeTimers();
	await value("#composer-input", "Old session request");
	await act(async () => sendButton().click());
	const submitted = socket.sent.find(command => command.type === "submit");
	await act(async () => socket.onclose?.({ code: 1006, reason: "Host restart" }));
	await act(async () => vi.advanceTimersByTimeAsync(1500));
	const replacement = Socket.sockets.at(-1)!;
	await act(async () => {
		replacement.onopen?.();
		replacement.receive({ type: "shared_snapshot", snapshot: {
			...snapshot, conversationSession: { id: "new-session", afterConversationSequence: 2 },
		} });
	});
	expect(replacement.sent.filter(command => command.type === "submit")).toHaveLength(0);
	const created = replacement.sent.find(command => command.type === "create_conversation");
	expect(created).toBeDefined();
	expect(container.querySelector<HTMLTextAreaElement>("#composer-input")!.value).toBe("");
	await act(async () => replacement.receive({ type: "command_accepted", requestId: created.requestId, result: { conversationId: "other" } }));
	await value("#composer-input", "New session draft");
	await act(async () => replacement.receive({ type: "command_accepted", requestId: submitted.requestId, result: { taskId: "old-task" } }));
	expect(container.querySelector<HTMLTextAreaElement>("#composer-input")!.value).toBe("New session draft");
});

it("reconnects after a patch produces an invalid snapshot and replays pending work", async () => {
	vi.useFakeTimers();
	await value("#composer-input", "Retain through bad patch");
	await act(async () => sendButton().click());
	const submitted = socket.sent.find(command => command.type === "submit");
	await act(async () => socket.receive({ type: "shared_patch", patch: {
		baseCursor: 0, values: {}, changes: { conversations: { upsert: [{ id: "conversation", title: 42 }] } },
	} }));
	expect(container.querySelector("h1")!.textContent).toBe("First");
	expect(container.querySelector<HTMLTextAreaElement>("#composer-input")!.readOnly).toBe(true);
	await act(async () => vi.advanceTimersByTimeAsync(1500));
	const replacement = Socket.sockets.at(-1)!;
	await act(async () => { replacement.onopen?.(); replacement.receive({ type: "shared_snapshot", snapshot }); });
	expect(replacement.sent.filter(command => command.type === "submit")).toEqual([submitted]);
	expect(container.querySelector<HTMLTextAreaElement>("#composer-input")!.value).toBe("Retain through bad patch");
});
