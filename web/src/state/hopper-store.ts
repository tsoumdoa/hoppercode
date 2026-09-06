import { createStore } from "zustand/vanilla";
import { combine } from "zustand/middleware";
import type { ImageAttachment, HostSnapshot } from "../../../src/host/protocol.js";
import type { ConnectionStatus, SendMode } from "./hopper-types";
import { createInitialHopperState, initialAuth } from "./initial-state";
import { createAuthActions } from "./auth-state";
import { createNotificationActions } from "./notifications";
import { createRuntimeActions } from "./runtime-state";
import { reduceAgentEvent, settleMessages } from "./conversation-state";
import { applySnapshot } from "./snapshot";
import { identifier } from "./identifiers";

export function createHopperStore() {
	return createStore(combine(createInitialHopperState(), (set) => ({
		actions: {
			...createAuthActions(set),
			...createNotificationActions(set),
			...createRuntimeActions(set),
			setConnection: (status: ConnectionStatus, detail: string, reconnectAttempt?: number) => set((state) => {
				const connection = { status, detail, reconnectAttempt: reconnectAttempt ?? state.connection.reconnectAttempt };
				const auth = status === "disconnected" || status === "error"
					? { ...initialAuth, completedCount: state.auth.completedCount }
					: state.auth;
				// Connection loss settles the conversation and auth in one update.
				return status === "connected" ? { connection } : { ...settleMessages(state, false), connection, auth };
			}),
			applySnapshot: (snapshot: HostSnapshot) => set((state) => applySnapshot(state, snapshot)),
			applyAgentEvent: (event: Record<string, unknown>) => set((state) => reduceAgentEvent(state, event)),
			setStreaming: (streaming: boolean) => set((state) => streaming
				? { session: { ...state.session, isStreaming: true } }
				: settleMessages(state, false)),
			setWorkingMessage: (text: string | null) => set({ workingMessage: text }),
			setSessionTitle: (title: string) => set((state) => ({ session: { ...state.session, name: title } })),
			addUserMessage: (text: string, kind: SendMode, images?: ImageAttachment[]) => {
				const id = identifier("user");
				set((state) => ({ session: {
					...state.session,
					isStreaming: kind === "prompt" ? true : state.session.isStreaming,
					messages: [...state.session.messages, { id, role: "user", kind, text, images, thinking: "", streaming: false, tools: [] }],
				} }));
			},
		},
	})));
}
