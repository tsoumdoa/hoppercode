import { connect as connectTcp } from "node:net";
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
		exportSession: vi.fn(() => ({ format: "hopper-session-debug", version: 1 } as ReturnType<HostRuntime["exportSession"]>)),
		prompt: vi.fn(async () => {}),
		steer: vi.fn(async () => {}),
		followUp: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		newSession: vi.fn(async () => {}),
		setModel: vi.fn(async () => {}),
		setThinkingLevel: vi.fn(),
		login: vi.fn(async () => {}),
		addProvider: vi.fn(async () => {}),
		refreshProviders: vi.fn(async () => {}),
		cancelAuth: vi.fn(),
		logout: vi.fn(async () => {}),
		listSkills: vi.fn(async () => ({ folder: "/skills", skills: [], diagnostics: [] })),
		listTools: vi.fn(() => ({ tools: [] })),
		updateToolSettings: vi.fn(async () => ({ ok: true, snapshot: { tools: [] } })),
		getToolSettings: vi.fn(async () => ({ tools: [{ name: "read", description: "Read skills", active: true, parameters: { type: "object" } }] })),
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
	it("exports the current session only with bearer authentication", async () => {
		const runtime = fakeRuntime();
		const server = await startHopperServer({ runtime, staticDir: await staticDirectory(), token: "export-secret", protocolHandshake, getRuntimeStatus });
		servers.push(server);
		const url = `http://${server.host}:${server.port}/api/session/export`;
		for (const suffix of ["", "?token=export-secret"]) {
			expect((await fetch(url + suffix)).status).toBe(403);
		}
		expect(runtime.exportSession).not.toHaveBeenCalled();
		const headers = { Authorization: "Bearer export-secret" };
		expect((await fetch(url, { method: "POST", headers })).status).toBe(405);
		const response = await fetch(url, { headers });
		expect(response.status).toBe(200);
		expect(response.headers.get("content-disposition")).toContain("hopper-session-debug.json");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual(runtime.exportSession());
		vi.mocked(runtime.exportSession).mockImplementation(() => { throw new Error("private detail"); });
		const failed = await fetch(url, { headers });
		expect(failed.status).toBe(500);
		expect(await failed.text()).not.toContain("private detail");
	});

	it("returns settings conflicts and never reflects credential input or backend errors", async () => {
		const runtime = fakeRuntime();
		const server = await startHopperServer({ runtime, staticDir: await staticDirectory(), token: "tools-token", protocolHandshake, getRuntimeStatus });
		servers.push(server);
		const endpoint = `http://${server.host}:${server.port}/api/tools`;
		const headers = { Authorization: "Bearer tools-token", "Content-Type": "application/json" };
		const action = { type: "credential", pluginId: "firecrawl", expected: { epoch: "test", revision: 0 }, action: "save", key: "sentinel-secret" };
		vi.mocked(runtime.updateToolSettings).mockResolvedValueOnce({ ok: false, code: "conflict", snapshot: { tools: [] } });
		const conflict = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(action) });
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toEqual({ ok: false, code: "conflict", snapshot: { tools: [] } });
		expect(runtime.updateToolSettings).toHaveBeenCalledWith(action);
		vi.mocked(runtime.updateToolSettings).mockRejectedValueOnce(new Error("sentinel-secret"));
		const failed = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(action) });
		expect(failed.status).toBe(400);
		expect(await failed.text()).not.toContain("sentinel-secret");
		const malformed = await fetch(endpoint, { method: "POST", headers, body: '{"key":"sentinel-secret"' });
		expect(malformed.status).toBe(400);
		expect(await malformed.text()).not.toContain("sentinel-secret");
		const oversized = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...action, key: "x".repeat(4097) }) });
		expect(oversized.status).toBe(400);
		expect(runtime.updateToolSettings).toHaveBeenCalledTimes(2);
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
});

it.each([false, true])("survives malformed request URLs, upgrade=%s", async (upgrade) => {
	const server = await startHopperServer({ runtime: fakeRuntime(), staticDir: await staticDirectory(), protocolHandshake, getRuntimeStatus });
	servers.push(server);
	const response = await new Promise<string>((resolve, reject) => {
		const socket = connectTcp(server.port, "127.0.0.1", () => {
			socket.write(`GET http://[ HTTP/1.1\r\nHost: localhost\r\n${upgrade ? "Connection: Upgrade\r\nUpgrade: websocket" : "Connection: close"}\r\n\r\n`);
		});
		let text = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => { text += chunk; });
		socket.on("end", () => resolve(text));
		socket.on("error", reject);
	});
	expect(response).toContain("400 Bad Request");
	expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
});
