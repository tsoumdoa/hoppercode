import type {
	ScriptLanguage,
	ScriptRecord,
	ScriptRevision,
	SourcePatch,
} from "../types/rhino-script-workspace.js";
import {
	applySourcePatches,
	boundedDiff,
	canonicalHash,
	fail,
	integer,
	normalizeSource,
	sourceHash,
	sourceLines,
} from "./source-line-patches.js";
import { RhinoScriptStore } from "./rhino-script-store.js";
export type ScriptMutation =
	| { action: "create"; name: string; language: ScriptLanguage; source: string }
	| {
			action: "patch";
			scriptId: string;
			expectedRevision: number;
			patches: SourcePatch[];
	  }
	| {
			action: "setSource";
			scriptId: string;
			expectedRevision: number;
			source: string;
	  }
	| {
			action: "rename";
			scriptId: string;
			expectedRevision: number;
			name: string;
	  }
	| {
			action: "restore";
			scriptId: string;
			expectedRevision: number;
			fromRevision: number;
	  }
	| {
			action: "delete" | "undelete";
			scriptId: string;
			expectedRevision: number;
	  };
export const revisionSummary = ({ source, ...revision }: ScriptRevision) => ({
	...revision,
	lineCount: sourceLines(source).length,
	endsWithNewline: source.endsWith("\n"),
});
export class RhinoScriptWorkspace {
	readonly store: RhinoScriptStore;
	constructor(directory: string, quotaBytes?: number) {
		this.store = new RhinoScriptStore(directory, quotaBytes);
	}
	get workspaceId(): string {
		return this.store.workspaceId;
	}
	reference(scriptId: string, revision: ScriptRevision) {
		return {
			workspaceId: this.workspaceId,
			scriptId,
			...revisionSummary(revision),
		};
	}
	readRecord(scriptId: string): ScriptRecord {
		if (!/^script_[a-f0-9]{32}_[a-f0-9]{32}$/.test(scriptId))
			fail("INVALID_ID", "Invalid script ID");
		if (!scriptId.startsWith(`script_${this.workspaceId}_`))
			fail("WORKSPACE_MISMATCH", "Script belongs to a different workspace");
		const record = this.store.read<ScriptRecord>(scriptId);
		if (
			record.schemaVersion !== 1 ||
			record.workspaceId !== this.workspaceId ||
			record.scriptId !== scriptId ||
			!Array.isArray(record.revisions) ||
			!record.revisions.length ||
			!record.mutations ||
			typeof record.mutations !== "object"
		)
			fail(
				"WORKSPACE_CORRUPT",
				"Invalid script record; retained for inspection",
			);
		for (const [i, r] of record.revisions.entries())
			if (
				r.revision !== i + 1 ||
				typeof r.source !== "string" ||
				r.hash !== sourceHash(r.source) ||
				!["python", "csharp"].includes(r.language) ||
				typeof r.name !== "string" ||
				typeof r.deleted !== "boolean"
			)
				fail(
					"WORKSPACE_CORRUPT",
					"Invalid script revision; retained for inspection",
				);
		return record;
	}
	resolve(
		scriptId: string,
		revision?: number,
		forExecution = false,
	): ScriptRevision {
		const record = this.readRecord(scriptId),
			head = record.revisions.at(-1)!;
		if (forExecution && head.deleted)
			fail("SCRIPT_DELETED", "Undelete the script before a new execution");
		if (revision !== undefined) integer(revision, 1);
		const result =
			revision === undefined ? head : record.revisions[revision - 1];
		if (!result)
			fail("REVISION_NOT_FOUND", `Revision ${revision} does not exist`);
		return result;
	}
	mutate(request: ScriptMutation, mutationId: string) {
		if (!mutationId || mutationId.length > 1024)
			fail("INVALID_INPUT", "A bounded mutation identity is required");
		const workspaceId = this.workspaceId,
			key = canonicalHash([workspaceId, mutationId]),
			payloadHash = canonicalHash(request);
		const scriptId =
			request.action === "create"
				? `script_${workspaceId}_${key.slice(0, 32)}`
				: request.scriptId;
		return this.store.transaction(() => {
			for (const id of this.store.list("script_")) {
				const retained = this.readRecord(id).mutations[key];
				if (retained && id !== scriptId)
					fail(
						"MUTATION_ID_CONFLICT",
						"Mutation identity already belongs to a different script",
					);
			}
			let record: ScriptRecord;
			if (request.action === "create" && !this.store.exists(scriptId))
				record = {
					schemaVersion: 1,
					workspaceId,
					scriptId,
					revisions: [],
					mutations: {},
				};
			else record = this.readRecord(scriptId);
			const replay = record.mutations[key];
			if (replay) {
				if (replay.payloadHash !== payloadHash)
					fail(
						"MUTATION_ID_CONFLICT",
						"Mutation identity was already used with a different payload",
					);
				return this.mutationResult(record, replay.revision, replay.changed);
			}
			const previous = record.revisions.at(-1);
			if (request.action !== "create") {
				integer(request.expectedRevision, 1);
				if (previous!.revision !== request.expectedRevision)
					fail(
						"REVISION_CONFLICT",
						"Read the current revision and reapply your change",
						{ currentRevision: previous!.revision },
					);
				if (
					previous!.deleted &&
					!["undelete", "delete"].includes(request.action)
				)
					fail("SCRIPT_DELETED", "Undelete before editing");
			}
			const next: ScriptRevision = previous
				? {
						...previous,
						revision: previous.revision + 1,
						createdAt: new Date().toISOString(),
					}
				: {
						revision: 1,
						name: "",
						language: "python",
						source: "",
						hash: "",
						deleted: false,
						createdAt: new Date().toISOString(),
					};
			switch (request.action) {
				case "create":
					next.name = request.name;
					next.language = request.language;
					next.source = normalizeSource(request.source);
					break;
				case "setSource":
					next.source = normalizeSource(request.source);
					break;
				case "patch":
					next.source = applySourcePatches(next.source, request.patches);
					break;
				case "rename":
					next.name = request.name;
					break;
				case "restore":
					next.source = this.resolve(scriptId, request.fromRevision).source;
					break;
				case "delete":
					next.deleted = true;
					break;
				case "undelete":
					next.deleted = false;
					break;
			}
			if (
				!next.name.trim() ||
				next.name.length > 200 ||
				/[\x00-\x1f]/.test(next.name)
			)
				fail(
					"INVALID_INPUT",
					"Script names must be 1–200 characters without control characters",
				);
			if (!["python", "csharp"].includes(next.language))
				fail("INVALID_INPUT", "Only Python and C# assets are supported");
			if (next.source.length > 64_000)
				fail("SOURCE_LIMIT_REACHED", "Source exceeds 64,000 characters");
			next.hash = sourceHash(next.source);
			const changed =
                request.action === "restore" ||
				!previous ||
				["name", "source", "deleted"].some(
					(k) =>
						previous[k as keyof ScriptRevision] !==
						next[k as keyof ScriptRevision],
				);
			if (changed) record.revisions.push(next);
			record.mutations[key] = {
				payloadHash,
				revision: changed ? next.revision : previous!.revision,
				changed,
			};
			this.store.assertCapacity([{ id: scriptId, value: record }]);
			this.store.write(scriptId, record);
			return this.mutationResult(
				record,
				record.mutations[key].revision,
				changed,
			);
		});
	}
	private mutationResult(
		record: ScriptRecord,
		revision: number,
		changed: boolean,
	) {
		const r = record.revisions[revision - 1],
			previous = record.revisions[revision - 2];
		return {
			...this.reference(record.scriptId, r),
			changed,
			diff: boundedDiff(
				changed ? (previous?.source ?? "") : r.source,
				r.source,
			),
		};
	}
	get(
		scriptId: string,
		revision?: number,
		startLine = 1,
		endLine?: number,
		characterOffset = 0,
	) {
		const r = this.resolve(scriptId, revision),
			lines = sourceLines(r.source);
		integer(startLine, 1, Math.max(1, lines.length));
		integer(characterOffset, 0, lines[startLine - 1]?.length ?? 0);
		if (characterOffset && (lines[startLine - 1]?.length ?? 0) <= 16_000)
			fail(
				"INVALID_INPUT",
				"characterOffset is only used for a long partial line",
			);
		const requestedEnd = endLine ?? lines.length;
		integer(requestedEnd, lines.length === 0 ? 0 : startLine, lines.length);
		const end = Math.min(requestedEnd, startLine + 199);
		const selected: Array<{ line: number; text: string }> = [];
		let chars = 0;
		for (let i = startLine - 1; i < end; i++) {
			const text = lines[i];
			if (chars + text.length > 16_000) break;
			selected.push({ line: i + 1, text });
			chars += text.length;
		}
		// A single 64k-character line cannot be represented as a complete line in a bounded response.
		const longLine =
			!selected.length && lines.length > 0
				? {
						line: startLine,
						text: lines[startLine - 1].slice(
							characterOffset,
							characterOffset + 16_000,
						),
						characterOffset,
						totalCharacters: lines[startLine - 1].length,
						nextCharacterOffset:
							characterOffset + 16_000 < lines[startLine - 1].length
								? characterOffset + 16_000
								: null,
						truncated: true,
					}
				: undefined;
		const completedLine =
			selected.at(-1)?.line ??
			(longLine?.nextCharacterOffset === null ? startLine : startLine - 1);
		return {
			...this.reference(scriptId, r),
			lines: selected,
			...(longLine ? { partialLine: longLine } : {}),
			truncated: completedLine < requestedEnd,
			nextLine:
				completedLine >= startLine && completedLine < requestedEnd
					? completedLine + 1
					: null,
		};
	}
	list(name?: string, includeDeleted = false, offset = 0, limit = 50) {
		integer(offset, 0);
		integer(limit, 1, 100);
		const assets = this.store
			.list("script_")
			.sort()
			.map((id) => this.reference(id, this.resolve(id)))
			.filter(
				(r) =>
					(includeDeleted || !r.deleted) &&
					(!name || r.name.toLowerCase().includes(name.toLowerCase())),
			);
		return {
			workspaceId: this.workspaceId,
			storagePath: this.store.directory,
			usedBytes: this.store.usage(),
			quotaBytes: this.store.quotaBytes,
			total: assets.length,
			items: assets.slice(offset, offset + limit),
			nextOffset: offset + limit < assets.length ? offset + limit : null,
		};
	}
	history(scriptId: string, offset = 0, limit = 50) {
		integer(offset, 0);
		integer(limit, 1, 100);
		const record = this.readRecord(scriptId);
		const runIds = this.store.list("batch_").flatMap((id) =>
			this.store
				.read<{ runs: Array<{ scriptId?: string; runId: string }> }>(id)
				.runs.filter((r) => r.scriptId === scriptId)
				.map((r) => r.runId),
		);
		return {
			workspaceId: this.workspaceId,
			scriptId,
			total: record.revisions.length,
			revisions: record.revisions
				.slice(offset, offset + limit)
				.map(revisionSummary),
			nextOffset:
				offset + limit < Math.max(record.revisions.length, runIds.length)
					? offset + limit
					: null,
			runIds: runIds.slice(offset, offset + limit),
			totalRuns: runIds.length,
		};
	}
	diff(scriptId: string, fromRevision: number, toRevision: number) {
		return {
			workspaceId: this.workspaceId,
			scriptId,
			fromRevision,
			toRevision,
			...boundedDiff(
				this.resolve(scriptId, fromRevision).source,
				this.resolve(scriptId, toRevision).source,
			),
		};
	}
}
