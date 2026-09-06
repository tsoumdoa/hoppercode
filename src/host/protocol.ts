export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type SkillSummary = {
	id: string;
	name: string;
	description: string;
	path: string;
	source: "bundled" | "user";
	enabled: boolean;
	manualOnly: boolean;
	files: string[];
};

export type SkillLibrarySnapshot = {
	folder: string;
	skills: SkillSummary[];
	diagnostics: string[];
};

export type SkillLibraryUpdate =
	| { type: "toggle"; id: string; enabled: boolean }
	| { type: "folder"; folder: string };

export function parseSkillLibraryUpdate(value: unknown): SkillLibraryUpdate {
	if (!isRecord(value)) throw new Error("Expected a skill setting");
	if (value.type === "folder") return { type: "folder", folder: stringField(value, "folder") };
	if (value.type === "toggle" && typeof value.enabled === "boolean") {
		return { type: "toggle", id: stringField(value, "id"), enabled: value.enabled };
	}
	throw new Error("Expected a folder or skill enable setting");
}

export type UiRequestKind = "select" | "confirm" | "input" | "editor" | "auth";

export type UiRequestMessage = {
	type: "ui_request";
	requestId: string;
	kind: UiRequestKind;
	title: string;
	options?: Array<{ id: string; value: string; label: string; description?: string }>;
	description?: string;
	placeholder?: string;
	prefill?: string;
	secret?: boolean;
};

export type ProviderAuthMethod = {
	type: "api_key" | "oauth";
	label: string;
};

export type ProviderSummary = {
	id: string;
	name: string;
	authenticated: boolean;
	authMethods: ProviderAuthMethod[];
};

export type HostSnapshot = {
	/** Partial response, which Pi has not yet added to messages. */
	streamingMessage?: JsonValue;
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	messages: JsonValue[];
	isStreaming: boolean;
	model?: { provider: string; id: string; name?: string; input?: string[] };
	thinkingLevel: string;
	availableThinkingLevels: string[];
	models: Array<{ provider: string; id: string; name?: string; input?: string[] }>;
	providers: ProviderSummary[];
};

export type ServerMessage =
	| { type: "message_accepted"; requestId: string }
	| { type: "snapshot"; snapshot: HostSnapshot }
	| { type: "agent_event"; event: JsonValue }
	| UiRequestMessage
	| { type: "ui_notification"; message: string; level: "info" | "warning" | "error" }
	| { type: "ui_status"; key: string; text?: string }
	| { type: "ui_widget"; key: string; lines?: string[]; placement?: string }
	| { type: "auth_event"; event: JsonValue }
	| { type: "status"; status: string; message?: string; scope?: string; provider?: string; streaming?: boolean }
	| { type: "session_replaced"; session: HostSnapshot }
	| { type: "error"; requestType?: string; requestId?: string; message: string };

export type ImageAttachment = { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" };
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

export function parseImages(value: unknown): ImageAttachment[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images`);
	return value.map((image) => {
		if (!isRecord(image) || image.type !== "image" || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(image.mimeType))) throw new Error("Use PNG, JPEG, WebP, or GIF images");
		if (typeof image.data !== "string" || !image.data.length || image.data.length > MAX_IMAGE_BASE64 || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error("Image must be valid base64 and at most 5 MB");
		const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
		if (image.data.length * 3 / 4 - padding > MAX_IMAGE_BYTES) throw new Error("Image must be at most 5 MB");
		return { type: "image", data: image.data, mimeType: image.mimeType as ImageAttachment["mimeType"] };
	});
}

export type ClientMessage =
	| { type: "authenticate"; token: string }
	| { type: "prompt"; text: string; images?: ImageAttachment[]; requestId?: string }
	| { type: "steer"; text: string; images?: ImageAttachment[]; requestId?: string }
	| { type: "follow_up"; text: string; images?: ImageAttachment[]; requestId?: string }
	| { type: "abort" }
	| { type: "new_session" }
	| { type: "set_model"; provider: string; id: string }
	| { type: "set_thinking"; level: string }
	| { type: "ui_response"; requestId: string; value: string | boolean | null }
	| { type: "login"; provider: string; authType: "api_key" | "oauth"; apiKey?: string }
	| { type: "logout"; provider: string }
	| { type: "snapshot" }
	| { type: "shutdown" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string {
	const field = value[key];
	if (typeof field !== "string" || !field.trim()) throw new Error(`${key} must be a non-empty string`);
	return field;
}

export function parseClientMessage(input: string): ClientMessage {
	let value: unknown;
	try {
		value = JSON.parse(input);
	} catch {
		throw new Error("Message must be valid JSON");
	}
	if (!isRecord(value) || typeof value.type !== "string") {
		throw new Error("Message must be an object with a type");
	}

	switch (value.type) {
		case "authenticate":
			return { type: value.type, token: stringField(value, "token") };
		case "prompt":
		case "steer":
		case "follow_up": {
			const images = parseImages(value.images);
			const text = images?.length && typeof value.text === "string" ? value.text : stringField(value, "text");
			const requestId = value.requestId === undefined ? undefined : stringField(value, "requestId");
			return { type: value.type, text, ...(images?.length ? { images } : {}), ...(requestId ? { requestId } : {}) };
		}
		case "abort":
		case "new_session":
		case "snapshot":
		case "shutdown":
			return { type: value.type };
		case "set_model":
			return {
				type: value.type,
				provider: stringField(value, "provider"),
				id: typeof value.id === "string" && value.id.trim() ? value.id : stringField(value, "modelId"),
			};
		case "set_thinking":
			return { type: value.type, level: stringField(value, "level") };
		case "login": {
			const authType = value.authType;
			if (authType !== "api_key" && authType !== "oauth") {
				throw new Error("authType must be api_key or oauth");
			}
			const apiKey = value.apiKey;
			if (apiKey !== undefined && (typeof apiKey !== "string" || !apiKey.trim())) {
				throw new Error("apiKey must be a non-empty string");
			}
			return { type: value.type, provider: stringField(value, "provider"), authType, apiKey };
		}
		case "logout":
			return { type: value.type, provider: stringField(value, "provider") };
		case "ui_response": {
			const responseValue = value.cancelled === true ? null : (value.value ?? value.result ?? null);
			if (responseValue !== null && typeof responseValue !== "string" && typeof responseValue !== "boolean") {
				throw new Error("value must be a string, boolean, or null");
			}
			return { type: value.type, requestId: stringField(value, "requestId"), value: responseValue };
		}
		default:
			throw new Error(`Unknown message type: ${value.type}`);
	}
}
