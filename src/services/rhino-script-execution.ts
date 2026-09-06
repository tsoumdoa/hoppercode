import { randomUUID } from "node:crypto";
import { getRuntimeRpc, RpcOperationError } from "../infra/runtime-rpc.js";
import type {
	OperationName,
	OperationResultSnapshot,
	JsonObject,
} from "../protocol/v2.js";
import type {
	BatchRecord,
	ExecutionDocument,
	InlineRunItem,
	RunItem,
	RunRecord,
} from "../types/rhino-script-workspace.js";
import {
	canonicalHash,
	fail,
	integer,
	sourceHash,
} from "./source-line-patches.js";
import {
	provenDead,
	RUN_RESERVE_BYTES,
	SCRIPT_PROCESS_ID,
} from "./rhino-script-store.js";
import { RhinoScriptWorkspace } from "./rhino-script-workspace.js";
import { validateRhinoScriptItem } from "./rhino-script-validator.js";
const activeRunnerClaims = new Set<string>();
export interface ScriptExecutionBackend {
	readonly lifecycleInstanceId: string;
	target(): Promise<{ document: ExecutionDocument | null; settings?: unknown }>;
	run(
		item: InlineRunItem,
		expectedDocument: ExecutionDocument | undefined,
		operationId: string,
		signal?: AbortSignal,
	): Promise<OperationResultSnapshot>;
	lookup(
		operationId: string,
	): Promise<{ state: string; result?: OperationResultSnapshot }>;
}
export function runtimeScriptBackend(): ScriptExecutionBackend {
	const rpc = getRuntimeRpc();
	return {
		lifecycleInstanceId: rpc.lifecycleInstanceId,
		async target() {
			// The document management branch owns this shared RPC contract. Older hosts reject the query.
			const res = await rpc.invoke("listRhinoDocuments" as OperationName, {});
			const data = res.result.data as unknown as {
				activeDocumentId?: string;
				documents?: Array<{
					documentId: string;
					lifecycleInstanceId: string;
					settings?: { settingsRevision?: string };
				}>;
			};
			if (!Array.isArray(data?.documents))
				fail(
					"CAPABILITY_UNAVAILABLE",
					"Backend does not support document identity and settings inspection",
				);
			const doc = data.documents.find(
				(d) => d.documentId === data.activeDocumentId,
			);
			return {
				document: doc
					? {
							documentId: doc.documentId,
							lifecycleInstanceId: doc.lifecycleInstanceId,
							...(doc.settings?.settingsRevision
								? { settingsRevision: doc.settings.settingsRevision }
								: {}),
						}
					: null,
				settings: doc?.settings,
			};
		},
		async run(item, expectedDocument, operationId, signal) {
			if (expectedDocument) {
				let target: Awaited<ReturnType<ScriptExecutionBackend["target"]>>;
				try {
					target = await this.target();
				} catch (error) {
					return {
						class: "capability_unavailable",
						reasonCode: "CAPABILITY_UNAVAILABLE",
						message: `Document inspection failed before execution: ${String(error)}`,
					};
				}
				if (
					!target.document ||
					target.document.documentId !== expectedDocument.documentId ||
					target.document.lifecycleInstanceId !==
						expectedDocument.lifecycleInstanceId
				)
					return {
						class: "failed",
						reasonCode: "OPERATION_FAILED",
						message:
							"DOCUMENT_CHANGED: Active document differs from the pinned execution target",
					};
				if (
					expectedDocument.settingsRevision &&
					target.document.settingsRevision !== expectedDocument.settingsRevision
				)
					return {
						class: "failed",
						reasonCode: "OPERATION_FAILED",
						message:
							"DOCUMENT_SETTINGS_CHANGED: Read current units/tolerances before running",
					};
			}
			const res = await rpc.invoke(
				"runRhinoScript",
				{
					...item,
					...(expectedDocument ? { expectedDocument } : {}),
				} as JsonObject,
				{ operationId, signal },
			);
			return res.result;
		},
		async lookup(operationId) {
			const res = await rpc.invoke("getOperationResult", { operationId });
			return res.result.data as unknown as {
				state: string;
				result?: OperationResultSnapshot;
			};
		},
	};
}
export const publicRun = ({
	source: _source,
	owner: _owner,
	...run
}: RunRecord) => run;
export class RhinoScriptExecution {
	constructor(
		readonly workspace: RhinoScriptWorkspace,
		private readonly backend: () => ScriptExecutionBackend = runtimeScriptBackend,
	) {}
	async getExecutionTarget() {
		return this.backend().target();
	}
	getRun(runId: string): RunRecord {
		const workspaceId = this.workspace.workspaceId;
		if (!/^run_[a-f0-9]{32}_[a-f0-9]{32}_[0-9]+$/.test(runId))
			fail("INVALID_ID", "Invalid run ID");
		if (!runId.startsWith(`run_${workspaceId}_`))
			fail("WORKSPACE_MISMATCH", "Run belongs to another workspace");
		const store = this.workspace.store;
		const batchId = runId.replace(/^run_/, "batch_").replace(/_[0-9]+$/, "");
		const run = store.exists(runId)
			? store.read<RunRecord>(runId)
			: this.batch(batchId).runs.find((r) => r.runId === runId);
		if (!run) fail("NOT_FOUND", "Run does not exist");
		if (
			run.schemaVersion !== 1 ||
			run.workspaceId !== workspaceId ||
			run.runId !== runId ||
			!Number.isSafeInteger(run.version) ||
			run.version < 1 ||
			!run.owner ||
			!Number.isSafeInteger(run.owner.pid) ||
			run.owner.pid < 1 ||
			typeof run.owner.processId !== "string" ||
			typeof run.owner.claimId !== "string" ||
			typeof run.operationId !== "string" ||
			typeof run.lifecycleInstanceId !== "string" ||
			run.batchId !== batchId ||
			typeof run.source !== "string" ||
			sourceHash(run.source) !== run.sourceHash ||
			![
				"prepared",
				"dispatching",
				"completed",
				"failed",
				"notStarted",
				"outcome_unknown",
				"notRun",
			].includes(run.state)
		)
			fail(
				"WORKSPACE_CORRUPT",
				"Invalid execution record; retained for inspection",
			);
		return run;
	}
	private batch(id: string): BatchRecord {
		const batch = this.workspace.store.read<BatchRecord>(id);
		if (
			batch.schemaVersion !== 1 ||
			batch.workspaceId !== this.workspace.workspaceId ||
			batch.batchId !== id ||
			!Array.isArray(batch.runs) ||
			!Array.isArray(batch.runIds) ||
			batch.runIds.length !== batch.runs.length ||
			batch.runs.some(
				(run, index) => run.runId !== batch.runIds[index] || run.batchId !== id,
			)
		)
			fail("WORKSPACE_CORRUPT", "Invalid batch inventory");
		return batch;
	}
	private update(run: RunRecord, change: Partial<RunRecord>): RunRecord {
		return this.workspace.store.transaction(() => {
			const current = this.getRun(run.runId);
			if (current.version !== run.version) {
				const terminal = ["completed", "failed", "notStarted", "notRun"];
				// An observer may have journaled uncertainty while native execution completed.
				// Promote the same claim's verified terminal result, but never regress a terminal record.
				if (
					!change.state ||
					!terminal.includes(change.state) ||
					terminal.includes(current.state) ||
					current.owner.claimId !== run.owner.claimId
				)
					return current;
			}
			const next = {
				...current,
				...change,
				version: current.version + 1,
				updatedAt: new Date().toISOString(),
			};
			this.workspace.store.write(run.runId, next);
			return next;
		});
	}
	async reconcileRun(runId: string): Promise<RunRecord> {
		let run = this.getRun(runId);
		if (["completed", "failed", "notStarted", "notRun"].includes(run.state))
			return run;
		if (run.state === "prepared") {
			if (
				(run.owner.processId === SCRIPT_PROCESS_ID &&
					!activeRunnerClaims.has(run.owner.claimId)) ||
				provenDead(run.owner.pid)
			)
				return this.update(run, {
					state: "notStarted",
					error: "Original runner died before dispatch",
				});
			return run;
		}
		if (
			run.owner.processId === SCRIPT_PROCESS_ID &&
			activeRunnerClaims.has(run.owner.claimId)
		)
			return run;
		let backend: ScriptExecutionBackend;
		try {
			backend = this.backend();
		} catch {
			return this.update(run, {
				state: "outcome_unknown",
				error:
					"Original backend is unavailable; inspect geometry before another explicit run",
			});
		}
		if (backend.lifecycleInstanceId !== run.lifecycleInstanceId)
			return this.update(run, {
				state: "outcome_unknown",
				error:
					"Original host lifecycle ended; result cannot be inferred from a new host",
			});
		try {
			const lookup = await backend.lookup(run.operationId);
			if (lookup.state === "terminal" && lookup.result)
				return this.update(run, this.resultChange(lookup.result));
			run = this.update(run, {
				state: "outcome_unknown",
				error:
					"Retained result is unavailable or pending. Source was not resubmitted.",
			});
		} catch (error) {
			run = this.update(run, {
				state: "outcome_unknown",
				error: String(error).slice(0, 2000),
			});
		}
		return run;
	}
	private resultChange(result: OperationResultSnapshot): Partial<RunRecord> {
		const data = result.data as
			| {
					ok?: boolean;
					output?: string;
					error?: unknown;
					settings?: unknown;
					documentSettings?: unknown;
					document?: unknown;
			  }
			| undefined;
		const output =
			typeof data?.output === "string"
				? data.output
				: data?.output === undefined
					? ""
					: JSON.stringify(data.output);
		const rawError = data?.error || result.message;
		const error =
			typeof rawError === "string"
				? rawError
				: rawError === undefined
					? undefined
					: JSON.stringify(rawError);
		const encoded = JSON.stringify(result);
		const rawSettings = data?.settings ?? data?.documentSettings;
		const encodedSettings = JSON.stringify(rawSettings);
		const settings =
			encodedSettings && Buffer.byteLength(encodedSettings) > 8000
				? { preview: encodedSettings.slice(0, 1000), truncated: true }
				: rawSettings;
		return {
			state:
				[
					"DOCUMENT_CHANGED",
					"DOCUMENT_SETTINGS_CHANGED",
					"SETTINGS_CHANGED",
				].includes(result.reasonCode) ||
				/^(DOCUMENT_CHANGED|DOCUMENT_SETTINGS_CHANGED|SETTINGS_CHANGED):/.test(
					result.message ?? "",
				)
					? "notStarted"
					: result.class === "completed"
						? data?.ok === false
							? "failed"
							: "completed"
						: [
									"deadline_exceeded_before_start",
									"cancelled_before_start",
									"busy",
									"capability_unavailable",
									"shutting_down",
							  ].includes(result.class)
							? "notStarted"
							: "failed",
			result:
				encoded.length > 12_000
					? { preview: encoded.slice(0, 12_000), truncated: true }
					: result,
			output: output.slice(0, 6000),
			outputTruncated: output.length > 6000,
			error: error?.slice(0, 2000),
			settings,
		};
	}
	async runBatch(items: RunItem[], identity: string, signal?: AbortSignal) {
		const workspaceId = this.workspace.workspaceId;
		const batchId = `batch_${workspaceId}_${canonicalHash([workspaceId, identity]).slice(0, 32)}`,
			payloadHash = canonicalHash(items),
			store = this.workspace.store;
		if (store.exists(batchId)) return this.replay(batchId, payloadHash);
		if (signal?.aborted)
			fail("ABORTED", "Cancelled before preparing execution");
		if (!Array.isArray(items) || !items.length || items.length > 100)
			fail("INVALID_INPUT", "Expected between 1 and 100 run items");
		// Resolve every immutable revision before the first mutation, then persist one atomic inventory.
		const resolved = items.map((item) => this.pin(item));
		const backend = this.backend();
		const mixedTarget = resolved.some((item) => !item.expectedDocument)
			? await backend.target()
			: undefined;
		if (mixedTarget && !mixedTarget.document)
			fail(
				"NO_ACTIVE_DOCUMENT",
				"A mixed batch requires an active Rhino document",
			);
		const pinned = resolved.map((item) =>
			item.expectedDocument
				? item
				: { ...item, expectedDocument: mixedTarget!.document! },
		);
		if (signal?.aborted)
			fail("ABORTED", "Cancelled while inspecting the execution target");
		for (const item of pinned)
			if (
				item.expectedDocument &&
				item.expectedDocument.lifecycleInstanceId !==
					backend.lifecycleInstanceId
			)
				fail(
					"DOCUMENT_CHANGED",
					"Expected document belongs to another host lifecycle",
				);
		const claimId = randomUUID(),
			now = new Date().toISOString();
		const batch: BatchRecord = {
			schemaVersion: 1,
			workspaceId,
			batchId,
			payloadHash,
			runIds: [],
			runs: pinned.map((item, index) => ({
				schemaVersion: 1,
				workspaceId,
				batchId,
				runId: batchId.replace(/^batch_/, "run_") + `_${index}`,
				version: 1,
				payloadHash: canonicalHash(items[index]),
				operationId: randomUUID(),
				lifecycleInstanceId: backend.lifecycleInstanceId,
				...item,
				state: "prepared",
				owner: { pid: process.pid, processId: SCRIPT_PROCESS_ID, claimId },
				createdAt: now,
				updatedAt: now,
			})),
		};
		batch.runIds = batch.runs.map((r) => r.runId);
		const admitted = store.transaction(() => {
			if (store.exists(batchId)) return false;
			store.assertCapacity(
				[{ id: batchId, value: batch }],
				batch.runs.reduce(
					(n, r) =>
						n + Buffer.byteLength(JSON.stringify(r)) + RUN_RESERVE_BYTES,
					0,
				),
			);
			store.write(batchId, batch);
			return true;
		});
		if (!admitted) return this.replay(batchId, payloadHash);
		activeRunnerClaims.add(claimId);
		try {
			const results: ReturnType<typeof publicRun>[] = [];
			let stop = false;
			for (const initial of batch.runs) {
				let run = this.getRun(initial.runId);
				if (stop || signal?.aborted) {
					run = this.update(run, {
						state: "notRun",
						error: signal?.aborted
							? "Batch cancelled before this item"
							: "Previous item did not complete successfully",
					});
					results.push(publicRun(run));
					stop = true;
					continue;
				}
				if (
					run.state !== "prepared" ||
					run.owner.claimId !== claimId ||
					run.owner.processId !== SCRIPT_PROCESS_ID
				) {
					results.push(publicRun(run));
					stop = true;
					continue;
				}
				run = this.update(run, { state: "dispatching" });
				if (run.state !== "dispatching" || run.owner.claimId !== claimId) {
					results.push(publicRun(run));
					stop = true;
					continue;
				}
				if (signal?.aborted) {
					run = this.update(run, {
						state: "notStarted",
						error: "Cancelled before transport dispatch",
					});
					results.push(publicRun(run));
					stop = true;
					continue;
				}
				let change: Partial<RunRecord>;
				try {
					change = this.resultChange(
						await backend.run(
							{ mode: run.mode, source: run.source, echo: run.echo },
							run.expectedDocument,
							run.operationId,
							signal,
						),
					);
				} catch (error) {
					change =
						error instanceof RpcOperationError
							? this.resultChange(error.result)
							: {
									state: "outcome_unknown",
									error: String(error).slice(0, 2000),
								};
				}
				try {
					run = this.update(run, change);
				} catch (error) {
					run = {
						...run,
						...change,
						recordingError: `Execution returned but journal finalization failed: ${String(error)}`,
					};
					stop = true;
				}
				results.push(publicRun(run));
				if (run.state !== "completed" || signal?.aborted) stop = true;
			}
			return { workspaceId, batchId, replayed: false, runs: results };
		} finally {
			activeRunnerClaims.delete(claimId);
		}
	}
	private async replay(batchId: string, payloadHash: string) {
		const batch = this.batch(batchId);
		if (batch.payloadHash !== payloadHash)
			fail(
				"MUTATION_ID_CONFLICT",
				"Execution call identity already has a different batch payload",
			);
		// Inspection never starts missing, prepared, or skipped work.
		const runs: ReturnType<typeof publicRun>[] = [];
		for (const runId of batch.runIds)
			runs.push(publicRun(await this.reconcileRun(runId)));
		return {
			workspaceId: this.workspace.workspaceId,
			batchId,
			replayed: true,
			runs,
		};
	}
	private pin(item: RunItem) {
		if ("scriptId" in item) {
			if ("source" in item || "mode" in item || "echo" in item)
				fail(
					"INVALID_INPUT",
					"Asset items cannot supply source, mode, or echo",
				);
			integer(item.revision, 1);
			const doc = item.expectedDocument;
			if (
				!doc ||
				typeof doc.documentId !== "string" ||
				!doc.documentId ||
				typeof doc.lifecycleInstanceId !== "string" ||
				!doc.lifecycleInstanceId
			)
				fail(
					"INVALID_INPUT",
					"Asset execution requires expectedDocument from getExecutionTarget",
				);
			if (
				item.expectedSettingsRevision !== undefined &&
				(typeof item.expectedSettingsRevision !== "string" ||
					!item.expectedSettingsRevision)
			)
				fail(
					"INVALID_INPUT",
					"expectedSettingsRevision must be a nonempty string",
				);
			if (
				doc.settingsRevision &&
				item.expectedSettingsRevision &&
				doc.settingsRevision !== item.expectedSettingsRevision
			)
				fail("INVALID_INPUT", "Conflicting settings revisions");
			const r = this.workspace.resolve(item.scriptId, item.revision, true);
			const validation = validateRhinoScriptItem({
				mode: r.language,
				source: r.source,
			});
			if (validation) fail("INVALID_SCRIPT", validation);
			return {
				scriptId: item.scriptId,
				revision: r.revision,
				sourceHash: r.hash,
				mode: r.language,
				source: r.source,
				expectedDocument: {
					...doc,
					...(item.expectedSettingsRevision
						? { settingsRevision: item.expectedSettingsRevision }
						: {}),
				},
			};
		}
		if (
			!["python", "csharp", "command"].includes(item.mode) ||
			typeof item.source !== "string"
		)
			fail("INVALID_INPUT", "Invalid inline script item");
		const validation = validateRhinoScriptItem(item);
		if (validation) fail("INVALID_SCRIPT", validation);
		return {
			...item,
			sourceHash: sourceHash(item.source),
			expectedDocument: undefined,
		};
	}
}
