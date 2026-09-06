import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { URL } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { LOOPBACK_HOST } from "./config.js";
import type { HostRuntime } from "./pi-runtime.js";
import { MAX_IMAGES, MAX_IMAGE_BASE64, parseClientMessage, parseSkillLibraryUpdate, type ClientMessage, type ServerMessage } from "./protocol.js";
import type { LiveProtocolHandshake } from "../infra/runtime-rpc.js";
import type { RuntimeStatus } from "../protocol/v2.js";

export type HopperServerOptions = {
	runtime: HostRuntime;
	staticDir: string;
	port?: number;
	token?: string;
	protocolHandshake: LiveProtocolHandshake;
	allowedDevOrigin?: string;
	getRuntimeStatus: (completionTimeoutMs?: number) => Promise<RuntimeStatus>;
	onShutdownRequest?: () => void;
};

export type HopperServer = {
	host: typeof LOOPBACK_HOST;
	port: number;
	token: string;
	url: string;
	lifecycleInstanceId: string;
	protocolHandshakeLive: true;
	close(): Promise<void>;
};

export function validateStaticDirectory(directory: string): string {
	const staticDir = realpathSync(resolve(directory));
	const indexPath = resolve(staticDir, "index.html");
	if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
		throw new Error(`Hopper web UI is missing: ${indexPath}`);
	}
	const realIndexPath = realpathSync(indexPath);
	if (!realIndexPath.startsWith(`${staticDir}${sep}`)) {
		throw new Error(`Hopper web UI index is outside its static directory: ${indexPath}`);
	}
	return staticDir;
}

const MIME_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".woff2": "font/woff2",
	".svg": "image/svg+xml",
};

function safeEqual(left: string, right: string): boolean {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(JSON.stringify(body));
}

function setPageHeaders(response: ServerResponse, contentType: string): void {
	response.setHeader("Content-Type", contentType);
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("Referrer-Policy", "no-referrer");
	response.setHeader("Cache-Control", "no-store");
	// Excalidraw declares CDN font fallbacks alongside locally hosted fonts.
	response.setHeader(
		"Content-Security-Policy",
		"default-src 'self'; connect-src 'self' ws:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data: https://esm.sh; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
	);
}

function serveStatic(staticDir: string, request: IncomingMessage, response: ServerResponse): void {
	if (request.method !== "GET" && request.method !== "HEAD") {
		writeJson(response, 405, { error: "Method not allowed" });
		return;
	}

	let pathname: string;
	try {
		pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
	} catch {
		writeJson(response, 400, { error: "Invalid URL" });
		return;
	}
	const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	const root = staticDir;
	let candidate = resolve(root, relative);
	if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
		writeJson(response, 404, { error: "Not found" });
		return;
	}
	if (!existsSync(candidate) || !statSync(candidate).isFile()) {
		writeJson(response, 404, { error: "Web UI assets are not installed" });
		return;
	}
	candidate = realpathSync(candidate);
	if (!candidate.startsWith(`${root}${sep}`)) {
		writeJson(response, 404, { error: "Not found" });
		return;
	}

	setPageHeaders(response, MIME_TYPES[extname(candidate).toLowerCase()] ?? "application/octet-stream");
	response.statusCode = 200;
	if (request.method === "HEAD") {
		response.end();
		return;
	}
	createReadStream(candidate).pipe(response);
}

function send(socket: WebSocket, message: ServerMessage): void {
	if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

async function dispatch(
	runtime: HostRuntime,
	message: ClientMessage,
	onShutdownRequest?: () => void,
	onAccepted?: () => void,
): Promise<void> {
	switch (message.type) {
		case "authenticate": throw new Error("Socket is already authenticated");
		case "prompt": return runtime.prompt(message.text, message.images, onAccepted);
		case "steer": await runtime.steer(message.text, message.images); onAccepted?.(); return;
		case "follow_up": await runtime.followUp(message.text, message.images); onAccepted?.(); return;
		case "abort": return runtime.abort();
		case "new_session": return runtime.newSession();
		case "set_model": return runtime.setModel(message.provider, message.id);
		case "set_thinking": runtime.setThinkingLevel(message.level); return;
		case "login": return runtime.login(message.provider, message.authType, message.apiKey);
		case "logout": return runtime.logout(message.provider);
		case "snapshot": runtime.bus.publish({ type: "snapshot", snapshot: runtime.snapshot() }); return;
		case "ui_response": {
			if (!runtime.ui.respond(message.requestId, message.value)) throw new Error("UI request is no longer pending");
			return;
		}
		case "shutdown": onShutdownRequest?.(); return;
	}
}

export async function startHopperServer(options: HopperServerOptions): Promise<HopperServer> {
	const staticDir = validateStaticDirectory(options.staticDir);
	const token = options.token ?? randomBytes(32).toString("base64url");
	const httpServer = createHttpServer((request, response) => {
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		if (pathname === "/api/skills") {
			const authorization = request.headers.authorization ?? "";
			if (!safeEqual(authorization.startsWith("Bearer ") ? authorization.slice(7) : "", token)) {
				writeJson(response, 403, { error: "Forbidden" });
				return;
			}
			if (request.method !== "GET" && request.method !== "POST") {
				writeJson(response, 405, { error: "Method not allowed" });
				return;
			}
			void (async () => {
				if (request.method === "POST") {
					const chunks: Buffer[] = [];
					let bytes = 0;
					for await (const chunk of request) {
						bytes += chunk.length;
						if (bytes > 16_384) throw new Error("Skill setting is too large");
						chunks.push(chunk);
					}
					const updated = await options.runtime.updateSkills(parseSkillLibraryUpdate(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
					writeJson(response, 200, updated);
					return;
				}
				const file = new URL(request.url ?? "/", "http://localhost").searchParams.get("file");
				if (request.method === "GET" && file) {
					writeJson(response, 200, { content: options.runtime.readSkill(file) });
				} else {
					writeJson(response, 200, await options.runtime.listSkills());
				}
			})().catch((error) => writeJson(response, 400, {
				error: error instanceof Error ? error.message : String(error),
			}));
			return;
		}
		if (pathname === "/health") {
			// Rhino's health monitor has a two-second HTTP deadline. Leave room for
			// response serialization after the authenticated status round trip.
			void options.getRuntimeStatus(1_500).then(
				(status) => {
					const lifecycleInstanceId = status.transport.lifecycleInstanceId;
					const protocolHandshakeLive = status.lifecycle.state === "running"
						&& status.host.state === "running"
						&& status.transport.ready
						&& lifecycleInstanceId === options.protocolHandshake.lifecycleInstanceId
						&& status.host.handshake === "live";
					writeJson(response, protocolHandshakeLive ? 200 : 503, {
						ok: protocolHandshakeLive,
						lifecycleInstanceId,
						protocolHandshakeLive,
					});
				},
				() => writeJson(response, 503, {
					ok: false,
					lifecycleInstanceId: options.protocolHandshake.lifecycleInstanceId,
					protocolHandshakeLive: false,
				}),
			);
			return;
		}
		if (pathname === "/api/runtime-status") {
			if (request.method !== "GET") {
				writeJson(response, 405, { error: "Method not allowed" });
				return;
			}
			const authorization = request.headers.authorization ?? "";
			const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
			if (!safeEqual(suppliedToken, token)) {
				writeJson(response, 403, { error: "Forbidden" });
				return;
			}
			void options.getRuntimeStatus().then(
				(status) => writeJson(response, 200, status),
				(error) => writeJson(response, 503, {
					error: error instanceof Error ? error.message : String(error),
				}),
			);
			return;
		}
		if (pathname === "/api/shutdown") {
			if (request.method !== "POST") {
				writeJson(response, 405, { error: "Method not allowed" });
				return;
			}
			const authorization = request.headers.authorization ?? "";
			const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
			if (!safeEqual(suppliedToken, token)) {
				writeJson(response, 403, { error: "Forbidden" });
				return;
			}
			writeJson(response, 202, { ok: true });
			setImmediate(() => options.onShutdownRequest?.());
			return;
		}
		serveStatic(staticDir, request, response);
	});
	const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_IMAGES * MAX_IMAGE_BASE64 + 1_048_576 });
	let controller: WebSocket | undefined;
	let unsubscribe = () => {};

	httpServer.on("upgrade", (request, socket, head) => {
		const address = httpServer.address();
		const port = typeof address === "object" && address ? address.port : undefined;
		const expectedOrigin = port ? `http://${LOOPBACK_HOST}:${port}` : "";
		const url = new URL(request.url ?? "/", expectedOrigin || "http://localhost");
		const suppliedOrigin = request.headers.origin;
		const allowedOrigin = suppliedOrigin === expectedOrigin
			|| (options.allowedDevOrigin !== undefined && suppliedOrigin === options.allowedDevOrigin);
		if (url.pathname !== "/ws" || !allowedOrigin) {
			socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		webSockets.handleUpgrade(request, socket, head, (webSocket) => webSockets.emit("connection", webSocket, request));
	});

	webSockets.on("connection", (socket) => {
		let authenticated = false;
		const authTimer = setTimeout(() => socket.close(4003, "Authentication timed out"), 5_000);
		authTimer.unref();

		const attachController = () => {
			authenticated = true;
			clearTimeout(authTimer);
			controller?.close(4001, "Replaced by another Hopper tab");
			controller = socket;
			unsubscribe();
			unsubscribe = options.runtime.bus.subscribe((message) => send(socket, message));
			send(socket, { type: "snapshot", snapshot: options.runtime.snapshot() });
			options.runtime.ui.replayPending();
		};

		socket.on("message", (raw: RawData) => {
			let parsed: ClientMessage;
			try {
				parsed = parseClientMessage(raw.toString());
			} catch (error) {
				// Validation failures still need to release the matching browser draft.
				let requestId: string | undefined;
				try { const value = JSON.parse(raw.toString()); if (typeof value?.requestId === "string") requestId = value.requestId; } catch { /* Invalid JSON has no request ID. */ }
				send(socket, { type: "error", requestId, message: error instanceof Error ? error.message : String(error) });
				if (authenticated && requestId) send(socket, { type: "snapshot", snapshot: options.runtime.snapshot() });
				return;
			}
			if (!authenticated) {
				if (parsed.type !== "authenticate" || !safeEqual(parsed.token, token)) {
					socket.close(4003, "Authentication failed");
					return;
				}
				attachController();
				return;
			}
			const requestId = "requestId" in parsed && ["prompt", "steer", "follow_up"].includes(parsed.type) ? parsed.requestId : undefined;
			const accepted = requestId ? () => send(socket, { type: "message_accepted", requestId }) : undefined;
			void dispatch(options.runtime, parsed, options.onShutdownRequest, accepted).catch((error) => {
				send(socket, {
					type: "error",
					requestType: parsed.type,
					requestId,
					message: error instanceof Error ? error.message : String(error),
				});
				if (["prompt", "steer", "follow_up"].includes(parsed.type)) {
					send(socket, { type: "snapshot", snapshot: options.runtime.snapshot() });
				}
			});
		});
		socket.on("close", () => {
			clearTimeout(authTimer);
			if (controller !== socket) return;
			controller = undefined;
			unsubscribe();
			unsubscribe = () => {};
		});
	});

	await new Promise<void>((resolveListen, reject) => {
		const onError = (error: Error) => reject(error);
		httpServer.once("error", onError);
		httpServer.listen(options.port ?? 0, LOOPBACK_HOST, () => {
			httpServer.off("error", onError);
			resolveListen();
		});
	});
	const address = httpServer.address();
	if (!address || typeof address === "string") throw new Error("Hopper server did not bind a TCP port");
	const port = address.port;

	return {
		host: LOOPBACK_HOST,
		port,
		token,
		url: `http://${LOOPBACK_HOST}:${port}/#${token}`,
		lifecycleInstanceId: options.protocolHandshake.lifecycleInstanceId,
		protocolHandshakeLive: options.protocolHandshake.protocolHandshakeLive,
		close: async () => {
			unsubscribe();
			for (const socket of webSockets.clients) socket.terminate();
			await new Promise<void>((resolveClose) => webSockets.close(() => resolveClose()));
			await new Promise<void>((resolveClose, reject) => {
				httpServer.close((error) => error ? reject(error) : resolveClose());
			});
		},
	};
}
