import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { HostMessageBus } from "./message-bus.js";
import type { HostRuntime } from "./pi-runtime.js";
import type { HostSnapshot, ServerMessage } from "./protocol.js";
import { startHopperServer, type HopperServer } from "./server.js";
import type { RuntimeStatus } from "../protocol/v2.js";

const protocolHandshake = {
	lifecycleInstanceId: "life-server-test",
	protocolHandshakeLive: true,
} as const;

const runtimeStatus: RuntimeStatus = {
	protocolVersion: 2,
	revision: 7,
	observedAt: 123,
	lifecycle: { state: "running", changedAt: 100, reason: null },
	transport: { ready: true, lifecycleInstanceId: "life-server-test" },
	host: {
		state: "running",
		processId: 42,
		nodePath: "/usr/local/bin/node",
		nodeVersion: "22.19.0",
		handshake: "live",
		healthFailureCount: 0,
	},
	rhino: { activeDocument: true, documentName: "model.3dm" },
	grasshopper: { state: "ready", activeDocument: true, documentName: "definition.gh" },
	dispatcher: { acceptingExternalWork: true, depth: 2, capacity: 64 },
	errors: { transport: null, host: null, rhino: null, grasshopper: null, dispatcher: null },
};

const getRuntimeStatus = async () => runtimeStatus;

const tempDirs: string[] = [];
const servers: HopperServer[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function snapshot(): HostSnapshot {
	return {
		sessionId: "session-1",
		messages: [],
		isStreaming: false,
		thinkingLevel: "medium",
		availableThinkingLevels: ["off", "medium"],
		models: [],
		providers: [],
	};
}

function fakeRuntime(): HostRuntime {
	return {
		bus: new HostMessageBus(),
		ui: { replayPending: vi.fn(), respond: vi.fn(() => true) },
		snapshot,
		prompt: vi.fn(async () => {}),
		steer: vi.fn(async () => {}),
		followUp: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		newSession: vi.fn(async () => {}),
		setModel: vi.fn(async () => {}),
		setThinkingLevel: vi.fn(),
		login: vi.fn(async () => {}),
		logout: vi.fn(async () => {}),
		listSkills: vi.fn(async () => ({ folder: "/skills", skills: [], diagnostics: [] })),
		readSkill: vi.fn(() => "# Test skill"),
		updateSkills: vi.fn(async () => ({ folder: "/skills", skills: [], diagnostics: [] })),
		dispose: vi.fn(async () => {}),
	};
}

async function staticDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "hopper-host-test-"));
	tempDirs.push(directory);
	await writeFile(join(directory, "index.html"), "<!doctype html><title>Hopper</title>");
	return directory;
}

function openSocket(server: HopperServer, origin = `http://${server.host}:${server.port}`): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(
			`ws://${server.host}:${server.port}/ws`,
			{ headers: { Origin: origin } },
		);
		socket.once("open", () => resolve(socket));
		socket.once("error", reject);
	});
}

function nextMessage(socket: WebSocket): Promise<ServerMessage> {
	return new Promise((resolve) => {
		socket.once("message", (data) => resolve(JSON.parse(data.toString()) as ServerMessage));
	});
}

describe("Hopper loopback server", () => {
	it.each(["prompt", "steer", "follow_up"] as const)("acknowledges %s only when the runtime accepts it", async (type) => {
		const runtime = fakeRuntime();
		let accept!: () => void;
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => { finish = resolve; });
		if (type === "prompt") runtime.prompt = vi.fn(async (_text, _images, onAccepted) => { accept = onAccepted!; await pending; });
		else runtime[type === "steer" ? "steer" : "followUp"] = vi.fn(() => pending);
		const server = await startHopperServer({ runtime, staticDir: await staticDirectory(), token: "receipt", protocolHandshake, getRuntimeStatus });
		servers.push(server);
		const socket = await openSocket(server);
		const initial = nextMessage(socket);
		socket.send(JSON.stringify({ type: "authenticate", token: "receipt" }));
		await initial;
		const received: ServerMessage[] = [];
		socket.on("message", (data) => received.push(JSON.parse(data.toString())));
		socket.send(JSON.stringify({ type, text: "Inspect", requestId: "submission-1" }));
		await vi.waitFor(() => expect(runtime[type === "follow_up" ? "followUp" : type]).toHaveBeenCalledOnce());
		expect(received).toEqual([]);
		const receipt = nextMessage(socket);
		if (type === "prompt") accept(); else finish();
		await expect(receipt).resolves.toEqual({ type: "message_accepted", requestId: "submission-1" });
		finish();
		socket.close();
	});

	it.each(["runtime", "validation"])("correlates %s rejection with the submitted draft", async (failure) => {
		const runtime = fakeRuntime();
		runtime.prompt = vi.fn(async () => { throw new Error("Authentication failed"); });
		const server = await startHopperServer({ runtime, staticDir: await staticDirectory(), token: "receipt", protocolHandshake, getRuntimeStatus });
		servers.push(server);
		const socket = await openSocket(server);
		const initial = nextMessage(socket);
		socket.send(JSON.stringify({ type: "authenticate", token: "receipt" }));
		await initial;
		const rejection = nextMessage(socket);
		const received: ServerMessage[] = [];
		socket.on("message", (data) => received.push(JSON.parse(data.toString())));
		socket.send(JSON.stringify({ type: "prompt", text: "Inspect", requestId: "rejected-draft", ...(failure === "validation" ? { images: [{}] } : {}) }));
		await expect(rejection).resolves.toMatchObject({ type: "error", requestId: "rejected-draft" });
		await vi.waitFor(() => expect(received).toContainEqual({ type: "snapshot", snapshot: snapshot() }));
		socket.close();
	});

	it("restores the active thread and progress after closing and reopening the browser", async () => {
		const runtime = fakeRuntime();
		let current: HostSnapshot = {
			...snapshot(),
			messages: [{ role: "user", content: "Build a sphere", timestamp: 1 }],
			isStreaming: true,
		};
		runtime.snapshot = () => current;
		const server = await startHopperServer({ runtime, staticDir: await staticDirectory(), protocolHandshake, getRuntimeStatus });
		servers.push(server);
		const first = await openSocket(server);
		const initial = nextMessage(first);
		first.send(JSON.stringify({ type: "authenticate", token: server.token }));
		await initial;
		const closed = new Promise<void>((resolve) => first.once("close", () => resolve()));
		first.close();
		await closed;

		current = { ...current, streamingMessage: { role: "assistant", content: [{ type: "text", text: "Creating the sphere" }] } };
		const reopened = await openSocket(server);
		const restored = nextMessage(reopened);
		reopened.send(JSON.stringify({ type: "authenticate", token: server.token }));
		await expect(restored).resolves.toEqual({ type: "snapshot", snapshot: current });
		expect(runtime.abort).not.toHaveBeenCalled();
		expect(runtime.newSession).not.toHaveBeenCalled();
		expect(runtime.dispose).not.toHaveBeenCalled();
		expect(runtime.ui.replayPending).toHaveBeenCalledTimes(2);
		reopened.close();
	});

	it("authenticates skill listing, previews and settings, and validates mutations", async () => {
		const runtime = fakeRuntime();
		const server = await startHopperServer({ runtime, staticDir: await staticDirectory(), token: "skills-token", protocolHandshake, getRuntimeStatus });
		servers.push(server);
		const endpoint = `http://${server.host}:${server.port}/api/skills`;
		const headers = { Authorization: "Bearer skills-token", "Content-Type": "application/json" };
		await expect(fetch(endpoint)).resolves.toMatchObject({ status: 403 });
		await expect(fetch(endpoint, { method: "POST", body: JSON.stringify({ type: "folder", folder: "/private" }) })).resolves.toMatchObject({ status: 403 });
		expect(runtime.listSkills).not.toHaveBeenCalled();
		expect(runtime.updateSkills).not.toHaveBeenCalled();
		await expect(fetch(endpoint, { headers }).then((response) => response.json())).resolves.toEqual({ folder: "/skills", skills: [], diagnostics: [] });
		await expect(fetch(`${endpoint}?file=${encodeURIComponent("/skills/rules.md")}`, { headers }).then((response) => response.json())).resolves.toEqual({ content: "# Test skill" });
		expect(runtime.readSkill).toHaveBeenCalledWith("/skills/rules.md");
		await expect(fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ type: "toggle", id: "rhino", enabled: false }) })).resolves.toMatchObject({ status: 200 });
		expect(runtime.updateSkills).toHaveBeenCalledWith({ type: "toggle", id: "rhino", enabled: false });
		await expect(fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ type: "toggle", id: "rhino", enabled: "false" }) })).resolves.toMatchObject({ status: 400 });
		await expect(fetch(endpoint, { method: "DELETE", headers })).resolves.toMatchObject({ status: 405 });
	});

	it.each([false, true])("restores actual streaming state after a rejected prompt, streaming=%s", async (isStreaming) => {
		const runtime = fakeRuntime();
		runtime.snapshot = () => ({ ...snapshot(), isStreaming });
		runtime.prompt = vi.fn(async () => { throw new Error("Prompt rejected"); });
		const server = await startHopperServer({ runtime, staticDir: await staticDirectory(), protocolHandshake, getRuntimeStatus });
		servers.push(server);
		const socket = await openSocket(server);
		const initial = nextMessage(socket);
		socket.send(JSON.stringify({ type: "authenticate", token: server.token }));
		await initial;
		const received: ServerMessage[] = [];
		socket.on("message", (data) => received.push(JSON.parse(data.toString())));
		socket.send(JSON.stringify({ type: "prompt", text: "Another prompt" }));
		await vi.waitFor(() => expect(received).toEqual([
			{ type: "error", requestType: "prompt", message: "Prompt rejected" },
			{ type: "snapshot", snapshot: runtime.snapshot() },
		]));
		socket.close();
	});

	it("fails before listening when the web UI is missing", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hopper-host-missing-ui-"));
		tempDirs.push(directory);
		await expect(startHopperServer({
			runtime: fakeRuntime(),
			staticDir: directory,
			protocolHandshake,
			getRuntimeStatus,
		}))
			.rejects.toThrow("web UI is missing");
	});

	it("serves health and static assets on loopback", async () => {
		const readStatus = vi.fn(async () => runtimeStatus);
		const server = await startHopperServer({
			runtime: fakeRuntime(),
			staticDir: await staticDirectory(),
			protocolHandshake,
			getRuntimeStatus: readStatus,
		});
		servers.push(server);

		await expect(fetch(`http://${server.host}:${server.port}/health`).then((response) => response.json()))
			.resolves.toEqual({
				ok: true,
				lifecycleInstanceId: "life-server-test",
				protocolHandshakeLive: true,
			});
		expect(readStatus).toHaveBeenCalledWith(1_500);
		await expect(fetch(`http://${server.host}:${server.port}/`).then((response) => response.text()))
			.resolves.toContain("<title>Hopper</title>");
		expect(server.url).toBe(`http://127.0.0.1:${server.port}/#${server.token}`);
	});

	it.each([
		...(["stopped", "faulted"] as const).map((state) => ({
			name: `lifecycle is ${state}`,
			status: {
				...runtimeStatus,
				lifecycle: { ...runtimeStatus.lifecycle, state },
			},
			expectedInstance: "life-server-test",
		})),
		...(["starting", "stopping", "faulted"] as const).map((state) => ({
			name: `host is ${state}`,
			status: {
				...runtimeStatus,
				host: { ...runtimeStatus.host, state },
			},
			expectedInstance: "life-server-test",
		})),
		{
			name: "transport is not ready",
			status: {
				...runtimeStatus,
				transport: { ready: false, lifecycleInstanceId: "life-server-test" },
			},
			expectedInstance: "life-server-test",
		},
		{
			name: "runtime status belongs to a stale lifecycle",
			status: {
				...runtimeStatus,
				transport: { ready: true, lifecycleInstanceId: "life-stale" },
			},
			expectedInstance: "life-stale",
		},
		{
			name: "Rhino marks the handshake failed",
			status: {
				...runtimeStatus,
				host: { ...runtimeStatus.host, handshake: "failed" as const },
			},
			expectedInstance: "life-server-test",
		},
	])("reports non-live health when $name", async ({ status, expectedInstance }) => {
		const server = await startHopperServer({
			runtime: fakeRuntime(),
			staticDir: await staticDirectory(),
			protocolHandshake,
			getRuntimeStatus: async () => status,
		});
		servers.push(server);

		const response = await fetch(`http://${server.host}:${server.port}/health`);
		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			lifecycleInstanceId: expectedInstance,
			protocolHandshakeLive: false,
		});
	});

	it("does not claim handshake liveness when Rhino status cannot be read", async () => {
		const server = await startHopperServer({
			runtime: fakeRuntime(),
			staticDir: await staticDirectory(),
			protocolHandshake,
			getRuntimeStatus: async () => { throw new Error("RPC disconnected"); },
		});
		servers.push(server);

		const response = await fetch(`http://${server.host}:${server.port}/health`);
		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			lifecycleInstanceId: "life-server-test",
			protocolHandshakeLive: false,
		});
	});

	it("authenticates a socket, sends a snapshot, and dispatches commands", async () => {
		const runtime = fakeRuntime();
		const server = await startHopperServer({
			runtime,
			staticDir: await staticDirectory(),
			token: "known-token",
			protocolHandshake,
			getRuntimeStatus,
		});
		servers.push(server);
		const socket = await openSocket(server);

		const initial = nextMessage(socket);
		socket.send(JSON.stringify({ type: "authenticate", token: server.token }));
		await expect(initial).resolves.toEqual({ type: "snapshot", snapshot: snapshot() });
		socket.send(JSON.stringify({ type: "prompt", text: "make a loft" }));
		await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalledWith("make a loft", undefined, undefined));

		const event = nextMessage(socket);
		runtime.bus.publish({ type: "ui_notification", message: "online", level: "info" });
		await expect(event).resolves.toEqual({ type: "ui_notification", message: "online", level: "info" });
		socket.close();
	});

	it.each(["prompt", "steer", "follow_up"] as const)("delivers image-only %s messages larger than the old socket limit", async (type) => {
		const runtime = fakeRuntime();
		const server = await startHopperServer({ runtime, staticDir: await staticDirectory(), token: "image-test", protocolHandshake, getRuntimeStatus });
		servers.push(server);
		const socket = await openSocket(server);
		const initial = nextMessage(socket);
		socket.send(JSON.stringify({ type: "authenticate", token: server.token }));
		await initial;
		const images = [{ type: "image", mimeType: "image/png", data: Buffer.alloc(1024 * 1024).toString("base64") }];
		socket.send(JSON.stringify({ type, text: "", images }));
		const deliver = vi.mocked(runtime[type === "follow_up" ? "followUp" : type]);
		await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
		expect(deliver.mock.calls[0].slice(0, 2)).toEqual(["", images]);
		socket.close();
	});

	it("rejects the wrong browser origin or token", async () => {
		const server = await startHopperServer({
			runtime: fakeRuntime(),
			staticDir: await staticDirectory(),
			token: "right",
			protocolHandshake,
			getRuntimeStatus,
		});
		servers.push(server);

		const socket = await openSocket(server);
		const status = await new Promise<number>((resolve) => {
			socket.once("close", (code) => resolve(code));
			socket.send(JSON.stringify({ type: "authenticate", token: "wrong" }));
		});
		expect(status).toBe(4003);
	});

	it("requires the bearer token for a graceful shutdown request", async () => {
		const onShutdownRequest = vi.fn();
		const server = await startHopperServer({
			runtime: fakeRuntime(),
			staticDir: await staticDirectory(),
			token: "shutdown-token",
			protocolHandshake,
			getRuntimeStatus,
			onShutdownRequest,
		});
		servers.push(server);
		const endpoint = `http://${server.host}:${server.port}/api/shutdown`;

		await expect(fetch(endpoint, { method: "POST" })).resolves.toMatchObject({ status: 403 });
		expect(onShutdownRequest).not.toHaveBeenCalled();
		await expect(fetch(endpoint, {
			method: "POST",
			headers: { Authorization: "Bearer shutdown-token" },
		})).resolves.toMatchObject({ status: 202 });
		await vi.waitFor(() => expect(onShutdownRequest).toHaveBeenCalledOnce());
	});

	it("rejects a WebSocket from another browser origin", async () => {
		const server = await startHopperServer({
			runtime: fakeRuntime(),
			staticDir: await staticDirectory(),
			protocolHandshake,
			getRuntimeStatus,
		});
		servers.push(server);
		const status = await new Promise<number>((resolve) => {
			const socket = new WebSocket(`ws://${server.host}:${server.port}/ws`, {
				headers: { Origin: "http://attacker.invalid" },
			});
			socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
		});
		expect(status).toBe(403);
	});

	it("rejects a WebSocket without an origin", async () => {
		const server = await startHopperServer({
			runtime: fakeRuntime(),
			staticDir: await staticDirectory(),
			protocolHandshake,
			getRuntimeStatus,
		});
		servers.push(server);
		const status = await new Promise<number>((resolve) => {
			const socket = new WebSocket(`ws://${server.host}:${server.port}/ws`);
			socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
		});
		expect(status).toBe(403);
	});

	it("permits only its explicitly configured Vite development origin", async () => {
		const server = await startHopperServer({
			runtime: fakeRuntime(),
			staticDir: await staticDirectory(),
			token: "dev-token",
			protocolHandshake,
			getRuntimeStatus,
			allowedDevOrigin: "http://localhost:5173",
		});
		servers.push(server);
		const socket = await openSocket(server, "http://localhost:5173");
		const initial = nextMessage(socket);
		socket.send(JSON.stringify({ type: "authenticate", token: "dev-token" }));
		await expect(initial).resolves.toEqual({ type: "snapshot", snapshot: snapshot() });
		socket.close();
	});

	it("returns Rhino's runtime snapshot unchanged only to an authenticated request", async () => {
		const readStatus = vi.fn(async () => runtimeStatus);
		const server = await startHopperServer({
			runtime: fakeRuntime(),
			staticDir: await staticDirectory(),
			token: "runtime-token",
			protocolHandshake,
			getRuntimeStatus: readStatus,
		});
		servers.push(server);
		const endpoint = `http://${server.host}:${server.port}/api/runtime-status`;

		await expect(fetch(endpoint)).resolves.toMatchObject({ status: 403 });
		expect(readStatus).not.toHaveBeenCalled();
		const response = await fetch(endpoint, {
			headers: { Authorization: "Bearer runtime-token" },
		});
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual(runtimeStatus);
		expect(readStatus).toHaveBeenCalledOnce();
		await expect(fetch(endpoint, {
			method: "POST",
			headers: { Authorization: "Bearer runtime-token" },
		})).resolves.toMatchObject({ status: 405 });
	});
});
