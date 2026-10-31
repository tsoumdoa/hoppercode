import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { createSharedBrowserServer } from "./browser-server.js";
import { applySnapshotPatch } from "./snapshot-patch.js";
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(
	snapshot: () => unknown = () => ({ events: [{ id: 7 }], tasks: [] }),
	ui: Partial<Parameters<typeof createSharedBrowserServer>[0]> = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "hopper-shared-server-"));
	writeFileSync(join(dir, "index.html"), "<html>Hopper</html>");
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const command = vi.fn(async () => ({ taskId: "t" }));
	const backend = { snapshot, command, subscribe: () => () => {} };
	const host = createSharedBrowserServer({
		backend,
		browserCredential: "secret",
		staticDir: dir,
		...ui,
	});
	await new Promise<void>((resolve) =>
		host.server.listen(0, "127.0.0.1", resolve),
	);
	cleanup.push(() => host.close());
	const port = (host.server.address() as { port: number }).port;
	const connect = async () => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/ws-shared`, {
			origin: `http://127.0.0.1:${port}`,
		});
		await new Promise<void>((resolve) => socket.once("open", resolve));
		return socket;
	};
	return { connect, command, port };
}
const next = (socket: WebSocket) =>
	new Promise<any>((resolve) =>
		socket.once("message", (raw) => resolve(JSON.parse(raw.toString()))),
	);
it("sends row patches after the initial snapshot and starts a replacement connection with a full snapshot", async () => {
	let state = { eventCursor: 1, tasks: [], events: [{ id: 1, kind: "progress", payload: "capture".repeat(10000) }] };
	let publish: ((event: unknown) => void) | undefined;
	const backend = { snapshot: () => state, command: async () => null,
		subscribe: (listener: (event: unknown) => void) => { publish = listener; return () => { publish = undefined; }; } };
	// The fixture's backend can be replaced through its normal server options.
	const f = await fixture(() => state, { backend });
	const socket = await f.connect();
	const initial = next(socket);
	socket.send(JSON.stringify({ type: "authenticate", token: "secret" }));
	const received = await initial;
	expect(received.type).toBe("shared_snapshot");
	state = { ...state, eventCursor: 2, events: [...state.events, { id: 2, kind: "progress", payload: "new text" }] };
	const update = next(socket);
	publish!({ type: "shared_snapshot", snapshot: state });
	const patch = await update;
	expect(patch.type).toBe("shared_patch");
	expect(JSON.stringify(patch)).not.toContain("capture");
	expect(applySnapshotPatch(received.snapshot, patch.patch)).toEqual(state);
	const replacement = await f.connect();
	const restored = next(replacement);
	replacement.send(JSON.stringify({ type: "authenticate", token: "secret" }));
	expect(await restored).toEqual({ type: "shared_snapshot", snapshot: state });
});
it("sends a fresh durable snapshot before accepting authenticated commands", async () => {
	const f = await fixture();
	const socket = await f.connect();
	const snapshot = next(socket);
	socket.send(JSON.stringify({ type: "authenticate", token: "secret" }));
	expect(await snapshot).toMatchObject({
		type: "shared_snapshot",
		snapshot: { events: [{ id: 7 }] },
	});
	const receipt = next(socket);
	socket.send(
		JSON.stringify({
			type: "create_conversation",
			requestId: "r",
			title: "Design",
		}),
	);
	expect(await receipt).toMatchObject({
		type: "command_accepted",
		requestId: "r",
	});
	expect(f.command).toHaveBeenCalledTimes(1);
});
it("replacement tab takes control without invoking cancellation", async () => {
	const f = await fixture();
	const first = await f.connect();
	const a = next(first);
	first.send(JSON.stringify({ type: "authenticate", token: "secret" }));
	await a;
	const second = await f.connect();
	const b = next(second);
	const closed = new Promise<number>((resolve) => first.once("close", resolve));
	second.send(JSON.stringify({ type: "authenticate", token: "secret" }));
	await b;
	expect(await closed).toBe(4001);
	expect(f.command).not.toHaveBeenCalled();
});
it("rejects unauthenticated commands and serves the normal application root", async () => {
	const f = await fixture();
	const socket = await f.connect();
	const closed = new Promise<number>((resolve) =>
		socket.once("close", resolve),
	);
	socket.send(
		JSON.stringify({
			type: "create_conversation",
			requestId: "r",
			title: "Design",
		}),
	);
	expect(await closed).toBe(4003);
	expect(f.command).not.toHaveBeenCalled();
	expect(
		await (await fetch(`http://127.0.0.1:${f.port}/`)).text(),
	).toContain("Hopper");
});

it("routes tool context only after authenticating the browser request", async () => {
	const runtime = { getToolSettings: vi.fn(async () => ({ tools: [] })) };
	const target = { getToolSettings: vi.fn(async () => ({ tools: [], context: { kind: "target" as const, label: "Selected target" } })), updateToolSettings: vi.fn(async () => ({ ok: true, snapshot: { tools: [] } })) };
	const tools = vi.fn((_query: URLSearchParams) => target);
	const f = await fixture(undefined, { uiRuntime: () => runtime as any, tools });
	const url = `http://127.0.0.1:${f.port}/api/tools?conversationId=second&taskId=running`;
	expect((await fetch(url)).status).toBe(403);
	expect(tools).not.toHaveBeenCalled();
	expect(await (await fetch(url, { headers: { Authorization: "Bearer secret" } })).json()).toMatchObject({ context: { kind: "target" } });
	expect(tools.mock.calls[0]?.[0]?.get("conversationId")).toBe("second");
	expect(runtime.getToolSettings).not.toHaveBeenCalled();
	await fetch(url, { method: "POST", headers: { Authorization: "Bearer secret" }, body: JSON.stringify({ type: "check-connection" }) });
	expect(target.updateToolSettings).toHaveBeenCalledWith({ type: "check-connection" });
});
