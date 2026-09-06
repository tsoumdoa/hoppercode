import { parseImages, type HostSnapshot } from "../../../src/host/protocol.js";
import type { ConversationMessage, HopperState, ToolCall } from "./hopper-types";
import { identifier } from "./identifiers";
import { textFromContent, thinkingFromContent, messageError } from "./conversation-state";
import { CONNECTED_DETAIL, DEFAULT_SESSION_NAME } from "./initial-state";

function toStoredMessages(messages: unknown, isStreaming = false): ConversationMessage[] {
	if (!Array.isArray(messages)) return [];
	const toolResults = new Map<string, { content: unknown; isError: boolean }>();
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const item = message as Record<string, unknown>;
		if (item.role === "toolResult" || item.role === "tool_result") {
			toolResults.set(String(item.toolCallId ?? item.id), { content: item.content, isError: Boolean(item.isError) });
		}
	}
	return messages.flatMap((message) => {
		if (!message || typeof message !== "object") return [];
		const item = message as Record<string, unknown>;
		if (item.role !== "user" && item.role !== "assistant") return [];
		const content = Array.isArray(item.content)
			? item.content.filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object")
			: [];
		const tools: ToolCall[] = content
			.filter((part) => ["toolCall", "tool_call", "tool_use"].includes(String(part.type)))
			.map((part) => {
				const id = String(part.id ?? part.toolCallId ?? identifier("tool"));
				const args = part.arguments ?? part.input;
				const result = toolResults.get(id);
				return {
					id,
					name: String(part.name ?? part.toolName ?? "Tool call"),
					args,
					detail: result?.content ?? args,
					status: result?.isError ? "error" : !result && isStreaming ? "running" : "complete",
				};
			});
		return [{
			id: String(item.id ?? identifier("message")),
			role: item.role,
			text: textFromContent(item.content),
			images: content.filter((part) => part.type === "image").flatMap((part) => {
				try { return parseImages([part]) ?? []; } catch { return []; }
			}),
			thinking: thinkingFromContent(content),
			error: item.role === "assistant" ? messageError(item) : undefined,
			streaming: false,
			tools,
		}];
	});
}

export function applySnapshot(state: HopperState, snapshot: HostSnapshot) {
	const messages = toStoredMessages(snapshot.messages, snapshot.isStreaming);
	const partial = snapshot.isStreaming
		? toStoredMessages([snapshot.streamingMessage], true).find((message) => message.role === "assistant")
		: undefined;
	if (partial) messages.push({ ...partial, streaming: true });
	return {
		connection: { status: "connected" as const, detail: CONNECTED_DETAIL, reconnectAttempt: 0 },
		session: {
			id: snapshot.sessionId || null,
			name: snapshot.sessionName || DEFAULT_SESSION_NAME,
			messages,
			isStreaming: Boolean(snapshot.isStreaming),
			activeAssistantId: partial?.id ?? null,
		},
		workingMessage: snapshot.isStreaming ? state.workingMessage : null,
		models: snapshot.models,
		providers: snapshot.providers,
		selectedModel: snapshot.model ?? null,
		thinkingLevel: snapshot.thinkingLevel,
		availableThinkingLevels: snapshot.availableThinkingLevels,
	};
}
