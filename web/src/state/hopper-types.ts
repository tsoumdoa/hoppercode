import type { StoreApi, ExtractState } from "zustand/vanilla";
import type { createHopperStore } from "./hopper-store";
import type { ImageAttachment, ClientMessage, HostSnapshot, UiRequestMessage } from "../../../src/host/protocol.js";
import type { RuntimeStatus } from "../../../src/protocol/v2.js";

export type SendMode = Extract<ClientMessage, { text: string }>["type"];

export type ToolCall = {
	id: string;
	name: string;
	/** Tool input, when the host reported it. */
	args?: unknown;
	/** Latest tool output. Falls back to `args` for display until a result arrives. */
	detail: unknown;
	status: "running" | "complete" | "error";
};

export type ConversationMessage = {
	id: string;
	role: "user" | "assistant";
	/** How a user message was delivered. Only set for locally sent messages. */
	kind?: SendMode;
	text: string;
	images?: ImageAttachment[];
	thinking: string;
	/** Provider or agent error reported for this assistant message. */
	error?: string;
	streaming: boolean;
	tools: ToolCall[];
};

export type ModelSummary = NonNullable<HostSnapshot["model"]>;
export type ProviderSummary = HostSnapshot["providers"][number];
export type UiRequest = Omit<UiRequestMessage, "type">;

export type ToastLevel = "info" | "warning" | "error" | "success";
export type ToastNotice = {
	id: string;
	message: string;
	level: ToastLevel;
	url?: string;
	label?: string;
	/** Milliseconds before the toast dismisses itself. */
	timeout: number;
};

export type ConnectionStatus = "connecting" | "authenticating" | "connected" | "disconnected" | "error";

export type AuthFlow = {
	/** A login or logout request is in flight. */
	busy: boolean;
	provider: string | null;
	notice: string | null;
	url?: string;
	label?: string;
	error: string | null;
	/** Increments every time a provider sign-in completes. */
	completedCount: number;
};

export type HopperState = {
	connection: { status: ConnectionStatus; detail: string; reconnectAttempt: number };
	session: { id: string | null; name: string; messages: ConversationMessage[]; isStreaming: boolean; activeAssistantId: string | null };
	workingMessage: string | null;
	models: ModelSummary[];
	providers: ProviderSummary[];
	selectedModel: ModelSummary | null;
	thinkingLevel: string;
	availableThinkingLevels: string[];
	pendingUiRequests: UiRequest[];
	activeUiRequest: UiRequest | null;
	notifications: ToastNotice[];
	runtimeStatus: RuntimeStatus | null;
	runtimeStatusError: string | null;
	backendDetail: string;
	auth: AuthFlow;
};

export type ConversationState = Pick<HopperState, "session" | "workingMessage">;
export type SidebarState = Pick<HopperState, "connection" | "backendDetail" | "providers" | "selectedModel" | "runtimeStatus" | "runtimeStatusError">;

export type SetHopperState = StoreApi<HopperState>["setState"];
export type HopperStore = ReturnType<typeof createHopperStore>;
export type HopperStoreState = ExtractState<HopperStore>;
