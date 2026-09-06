import { createHash } from "node:crypto";
import type { SourcePatch } from "../types/rhino-script-workspace.js";
export class ScriptWorkspaceError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly details?: unknown,
	) {
		super(`${code}: ${message}`);
	}
}
export function fail(code: string, message: string, details?: unknown): never {
	throw new ScriptWorkspaceError(code, message, details);
}
export const normalizeSource = (source: string): string =>
	source.replace(/\r\n?/g, "\n");
// A trailing newline is a separator after the final line, not an extra editable line.
export function sourceLines(source: string): string[] {
	return source === ""
		? []
		: (source.endsWith("\n") ? source.slice(0, -1) : source).split("\n");
}
export function sourceHash(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}
export function canonicalHash(value: unknown): string {
	const canonical = (v: unknown): unknown =>
		Array.isArray(v)
			? v.map(canonical)
			: v && typeof v === "object"
				? Object.fromEntries(
						Object.entries(v)
							.filter(([, x]) => x !== undefined)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([k, x]) => [k, canonical(x)]),
					)
				: v;
	return sourceHash(JSON.stringify(canonical(value)));
}
export function integer(
	value: number,
	min: number,
	max = Number.MAX_SAFE_INTEGER,
): void {
	if (!Number.isSafeInteger(value) || value < min || value > max)
		fail("INVALID_INPUT", `Expected an integer between ${min} and ${max}`);
}
export function applySourcePatches(
	source: string,
	patches: SourcePatch[],
): string {
	if (!Array.isArray(patches))
		fail("INVALID_PATCH", "patches must be an array");
	const lines = sourceLines(source);
	const edits = patches.map((p) => {
		if (!["insert", "replace", "delete"].includes(p.action))
			fail("INVALID_PATCH", "Unknown patch action");
		if (
			p.action !== "delete" &&
			(!Array.isArray(p.lines) ||
				p.lines.some((l) => typeof l !== "string" || /[\r\n]/.test(l)))
		)
			fail("INVALID_PATCH", "lines must contain single-line strings");
		if (p.action === "insert") {
			integer(p.afterLine, 0, lines.length);
			return {
				start: p.afterLine,
				end: p.afterLine,
				insert: true,
				lines: p.lines,
			};
		}
		integer(p.startLine, 1, lines.length);
		integer(p.endLine, p.startLine, lines.length);
		if (
			p.expectedText !== undefined &&
			p.expectedText !== lines.slice(p.startLine - 1, p.endLine).join("\n")
		)
			fail("TEXT_CONFLICT", "expectedText does not match the original span");
		return {
			start: p.startLine - 1,
			end: p.endLine,
			insert: false,
			lines: p.action === "replace" ? p.lines : [],
		};
	});
	for (let i = 0; i < edits.length; i++)
		for (let j = i + 1; j < edits.length; j++) {
			const a = edits[i],
				b = edits[j];
			const overlap =
				a.insert && b.insert
					? a.start === b.start
					: a.insert
						? a.start >= b.start && a.start < b.end
						: b.insert
							? b.start >= a.start && b.start < a.end
							: a.start < b.end && b.start < a.end;
			if (overlap)
				fail(
					"OVERLAPPING_PATCHES",
					"All patches refer to the original revision; overlapping edits are invalid",
				);
		}
	for (const e of edits.sort((a, b) => b.start - a.start))
		lines.splice(e.start, e.end - e.start, ...e.lines);
	return lines.join("\n") + (source.endsWith("\n") && lines.length ? "\n" : "");
}
export function boundedDiff(before: string, after: string, maxChars = 12_000) {
	const a = sourceLines(before),
		b = sourceLines(after);
	let start = 0,
		endA = a.length,
		endB = b.length;
	while (start < endA && start < endB && a[start] === b[start]) start++;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const text =
		before === after
			? ""
			: [
					`@@ -${start + 1},${endA - start} +${start + 1},${endB - start} @@`,
					...a.slice(start, endA).map((l) => `-${l}`),
					...b.slice(start, endB).map((l) => `+${l}`),
					...(before.endsWith("\n") !== after.endsWith("\n")
						? [`Final newline: ${after.endsWith("\n")}`]
						: []),
				].join("\n");
	return {
		text: text.slice(0, maxChars),
		truncated: text.length > maxChars,
		totalCharacters: text.length,
	};
}
