import { createHash } from "node:crypto";

const BASE62_ALPHABET =
	"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const DEFAULT_SHORT_LENGTH = 4;
const MAX_SHORT_LENGTH = 22;

type GuidKind = "type" | "instance" | "rhino";

type GuidStore = {
	shortToFull: Map<string, string>;
	normalizedToFull: Map<string, string>;
	normalizedToShort: Map<string, string>;
};

const stores: Record<GuidKind, GuidStore> = {
	type: {
		shortToFull: new Map(),
		normalizedToFull: new Map(),
		normalizedToShort: new Map(),
	},
	instance: {
		shortToFull: new Map(),
		normalizedToFull: new Map(),
		normalizedToShort: new Map(),
	},
	rhino: {
		shortToFull: new Map(),
		normalizedToFull: new Map(),
		normalizedToShort: new Map(),
	},
};

function normalizeGuid(guid: string): string {
	return guid.trim().toLowerCase().replace(/[{}-]/g, "");
}

function looksLikeGuid(value: string): boolean {
	const normalized = normalizeGuid(value);
	return /^[0-9a-f]{32}$/.test(normalized);
}

function encodeBase62(buffer: Buffer): string {
	let num = BigInt(`0x${buffer.toString("hex")}`);
	if (num === 0n) return BASE62_ALPHABET[0];

	let output = "";
	const base = BigInt(BASE62_ALPHABET.length);

	while (num > 0n) {
		output = BASE62_ALPHABET[Number(num % base)] + output;
		num /= base;
	}

	return output;
}

export function shortGuidBase62(guid: string, length = DEFAULT_SHORT_LENGTH): string {
	const normalized = normalizeGuid(guid);
	const hash = createHash("sha256").update(normalized).digest();
	return encodeBase62(hash).slice(0, length);
}

function registerGuid(guid: string, kind: GuidKind): string {
	const store = stores[kind];
	const normalized = normalizeGuid(guid);

	const existingShort = store.normalizedToShort.get(normalized);
	if (existingShort) {
		return existingShort;
	}

	for (let length = DEFAULT_SHORT_LENGTH; length <= MAX_SHORT_LENGTH; length++) {
		const short = shortGuidBase62(normalized, length);
		const existingFull = store.shortToFull.get(short);

		if (!existingFull || normalizeGuid(existingFull) === normalized) {
			store.shortToFull.set(short, guid);
			store.normalizedToFull.set(normalized, guid);
			store.normalizedToShort.set(normalized, short);
			return short;
		}
	}

	const fallback = shortGuidBase62(normalized, MAX_SHORT_LENGTH);
	const uniqueFallback = `${fallback}${shortGuidBase62(normalized + kind, 2)}`;
	store.shortToFull.set(uniqueFallback, guid);
	store.normalizedToFull.set(normalized, guid);
	store.normalizedToShort.set(normalized, uniqueFallback);
	return uniqueFallback;
}

function resolveGuid(value: string, kind: GuidKind): string {
	const store = stores[kind];
	const byShort = store.shortToFull.get(value);
	if (byShort) {
		return byShort;
	}

	if (looksLikeGuid(value)) {
		const normalized = normalizeGuid(value);
		const knownFull = store.normalizedToFull.get(normalized);
		if (knownFull) {
			return knownFull;
		}
		return value;
	}

	return value;
}

export function toShortTypeGuid(guid: string): string {
	if (!guid) return guid;
	return registerGuid(guid, "type");
}

export function toShortInstanceGuid(guid: string): string {
	if (!guid) return guid;
	return registerGuid(guid, "instance");
}

export function resolveTypeGuid(value: string): string {
	if (!value) return value;
	return resolveGuid(value, "type");
}

export function resolveInstanceGuid(value: string): string {
	if (!value) return value;
	return resolveGuid(value, "instance");
}

export function toShortRhinoGuid(guid: string): string {
	if (!guid) return guid;
	return registerGuid(guid, "rhino");
}

export function resolveRhinoGuid(value: string): string {
	if (!value) return value;
	return resolveGuid(value, "rhino");
}

export function resolveRhinoGuids(values: string[]): string[] {
	return values.map(resolveRhinoGuid);
}

/** Forget aliases scoped to the document that just ended or changed. Type GUIDs are global. */
export function clearDocumentGuidAliases(owner: "rhino" | "grasshopper"): void {
	const store = stores[owner === "rhino" ? "rhino" : "instance"];
	store.shortToFull.clear();
	store.normalizedToFull.clear();
	store.normalizedToShort.clear();
}
