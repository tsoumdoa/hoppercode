import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImageAttachment, ClientMessage, ServerMessage } from "../../../src/host/protocol.js";
import { useHopperStoreApi } from "../state/hopper-store-context";
import { handleServerMessage, CONNECTED_STATUSES } from "../state/server-messages";
import type { SendMode } from "../state/hopper-types";
import { MockHopperTransport } from "../mocks/hopper-mock";

export const isMockMode = import.meta.env.MODE === "mock";
export type PromptReceipt = { onAccepted(): void; onRejected(): void };

function readToken() {
	const raw = window.location.hash.slice(1);
	let token = "";
	if (raw) {
		const params = new URLSearchParams(raw);
		try {
			token = params.get("token") || (raw.includes("=") ? "" : decodeURIComponent(raw));
		} catch {
			token = "";
		}
		if (token) {
			sessionStorage.setItem("hopper.sessionToken", token);
			history.replaceState(null, "", `${location.pathname}${location.search}`);
		}
	}
	return token || sessionStorage.getItem("hopper.sessionToken") || "";
}

function socketUrl() {
	const url = new URL("/ws", window.location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

export function useHopperConnection() {
	const store = useHopperStoreApi();
	const actions = store.getState().actions;
	const { toast } = actions;
	const socket = useRef<WebSocket | null>(null);
	const mockTransport = useRef<MockHopperTransport | null>(null);
	const reconnectTimer = useRef<number | null>(null);
	const attempt = useRef(0);
	const authenticated = useRef(false);
	const pendingPrompts = useRef(new Map<string, PromptReceipt>());
	const rejectPendingPrompts = useCallback(() => {
		const pending = [...pendingPrompts.current.values()];
		pendingPrompts.current.clear();
		for (const receipt of pending) receipt.onRejected();
	}, []);
	const reconnectBlocked = useRef(false);
	const token = useMemo(() => (isMockMode ? "mock-session" : readToken()), []);
	const [reconnectNonce, setReconnectNonce] = useState(0);

	const receive = useCallback((message: ServerMessage) => {
		if ((message.type === "message_accepted" || message.type === "error") && message.requestId) {
			const receipt = pendingPrompts.current.get(message.requestId);
			pendingPrompts.current.delete(message.requestId);
			if (message.type === "message_accepted") receipt?.onAccepted();
			else receipt?.onRejected();
		}
		if (message.type === "message_accepted") return;
		if (message.type === "session_replaced") rejectPendingPrompts();
		if (message.type === "snapshot" || message.type === "session_replaced" || (message.type === "status" && CONNECTED_STATUSES.includes(message.status))) {
			authenticated.current = true;
			attempt.current = 0;
		}
		handleServerMessage(store, message);
	}, [store, rejectPendingPrompts]);

	const send = useCallback((message: ClientMessage) => {
		if (isMockMode && mockTransport.current) {
			mockTransport.current.send(message);
			return true;
		}
		if (!socket.current || socket.current.readyState !== WebSocket.OPEN) {
			toast("Hopper is not connected.", "error");
			return false;
		}
		if (!authenticated.current) {
			toast("Hopper is still authenticating.", "warning");
			return false;
		}
		try { socket.current.send(JSON.stringify(message)); }
		catch { toast("Could not send the message. Your draft is still available.", "error"); return false; }
		return true;
	}, [toast]);

	const reconnect = useCallback(() => {
		rejectPendingPrompts();
		reconnectBlocked.current = false;
		if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
		reconnectTimer.current = null;
		attempt.current = 0;
		if (isMockMode) {
			mockTransport.current?.close();
		} else {
			socket.current?.close(1000, "Reconnect requested");
			socket.current = null;
		}
		setReconnectNonce((value) => value + 1);
	}, [rejectPendingPrompts]);

	useEffect(() => {
		if (isMockMode) {
			authenticated.current = true;
			actions.setConnection("authenticating", "Starting the local mock Hopper session");
			const transport = new MockHopperTransport(receive);
			mockTransport.current = transport;
			transport.connect();
			return () => {
				if (mockTransport.current === transport) mockTransport.current = null;
				transport.close();
			};
		}
		if (!token) {
			actions.setConnection("error", "This page has no Hopper session token. Run _HopperCode in Rhino to open a fresh link.");
			return;
		}
		authenticated.current = false;
		actions.setConnection("connecting", "Opening the local Hopper host", attempt.current);
		const current = new WebSocket(socketUrl());
		socket.current = current;
		current.addEventListener("open", () => {
			if (socket.current !== current) return;
			actions.setConnection("authenticating", "Confirming the Rhino session");
			current.send(JSON.stringify({ type: "authenticate", token }));
		});
		current.addEventListener("message", (event) => {
			if (socket.current !== current) return;
			let message: ServerMessage;
			try {
				message = JSON.parse(String(event.data)) as ServerMessage;
			} catch {
				toast("Hopper sent an unreadable message.", "error");
				return;
			}
			receive(message);
		});
		current.addEventListener("close", (event) => {
			if (socket.current !== current) return;
			rejectPendingPrompts();
			socket.current = null;
			authenticated.current = false;
			const reason = event.reason || "The local host closed the connection";
			// A replaced tab must yield control until the user explicitly reconnects.
			if (event.code === 4001 || event.code === 4003) {
				reconnectBlocked.current = true;
				actions.setConnection("disconnected", event.code === 4001
					? `${reason}. Click Reconnect to use this tab.`
					: `${reason}. Run _HopperCode in Rhino to open a fresh link.`);
				return;
			}
			const delay = Math.min(1_000 * 2 ** attempt.current, 10_000);
			attempt.current += 1;
			actions.setConnection("disconnected", `${reason}. Retrying in ${Math.ceil(delay / 1000)}s…`, attempt.current);
			reconnectTimer.current = window.setTimeout(() => {
				reconnectTimer.current = null;
				setReconnectNonce((value) => value + 1);
			}, delay);
		});
		current.addEventListener("error", () => {
			if (socket.current === current) actions.setConnection("error", "The local Hopper host did not respond");
		});
		return () => {
			if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
			reconnectTimer.current = null;
			if (socket.current === current) socket.current = null;
			current.close(1000, "Page updated");
		};
	}, [actions, receive, reconnectNonce, rejectPendingPrompts, toast, token]);

	useEffect(() => {
		const onOnline = () => {
			if (reconnectBlocked.current) return;
			if (!socket.current || socket.current.readyState !== WebSocket.OPEN) reconnect();
		};
		window.addEventListener("online", onOnline);
		return () => window.removeEventListener("online", onOnline);
	}, [reconnect]);

	const prompt = useCallback((text: string, type: SendMode, images?: ImageAttachment[], receipt?: PromptReceipt) => {
		const requestId = receipt ? crypto.randomUUID() : undefined;
		if (receipt && requestId) pendingPrompts.current.set(requestId, receipt);
		if (!send({ type, text, ...(images?.length ? { images } : {}), ...(requestId ? { requestId } : {}) })) {
			if (requestId) pendingPrompts.current.delete(requestId);
			return false;
		}
		actions.addUserMessage(text, type, images);
		return true;
	}, [actions, send]);

	const login = useCallback((provider: string, authType: "api_key" | "oauth", apiKey?: string) => {
		const notice = authType === "oauth" ? "Starting browser sign-in…" : "Checking the API key…";
		if (!send({ type: "login", provider, authType, ...(apiKey ? { apiKey } : {}) })) return false;
		actions.startAuth(provider, notice);
		return true;
	}, [actions, send]);

	const logout = useCallback((provider: string) => {
		if (!send({ type: "logout", provider })) return false;
		actions.startAuth(provider, "Signing out…");
		return true;
	}, [actions, send]);

	return { token, send, prompt, login, logout, reconnect, isMockMode };
}
