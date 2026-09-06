import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RhinoScriptWorkspace } from "./rhino-script-workspace.js";
import {
	RhinoScriptExecution,
	runtimeScriptBackend,
	type ScriptExecutionBackend,
} from "./rhino-script-execution.js";
import * as runtimeRpc from "../infra/runtime-rpc.js";
import type { RunItem, RunRecord } from "../types/rhino-script-workspace.js";
import type { OperationResultSnapshot } from "../protocol/v2.js";
const dirs: string[] = [];
const target = {
	documentId: "doc",
	lifecycleInstanceId: "host",
	settingsRevision: "settings-1",
};
const ok: OperationResultSnapshot = {
	class: "completed",
	reasonCode: "OK",
	data: {
		ok: true,
		output: "done",
		settings: { units: "millimeters", settingsRevision: "settings-1" },
	},
};
function setup(quota?: number) {
	const directory = mkdtempSync(join(tmpdir(), "hopper-runs-"));
	dirs.push(directory);
	const w = new RhinoScriptWorkspace(directory, quota);
	const asset = w.mutate(
		{
			action: "create",
			name: "circle",
			language: "python",
			source: "print(1)",
		},
		"create",
	);
	const backend: ScriptExecutionBackend = {
		lifecycleInstanceId: "host",
		target: vi.fn(async () => ({ document: target })),
		run: vi.fn(async () => ok),
		lookup: vi.fn(async () => ({ state: "notFound" })),
	};
	const execution = new RhinoScriptExecution(w, () => backend);
	const item = {
		scriptId: asset.scriptId,
		revision: 1,
		expectedDocument: target,
	};
	return { w, asset, backend, execution, item };
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
describe("durable execution admission", () => {
	it("paginates every execution when run history exceeds revision history", async () => {
		const { w, execution, item } = setup();
		const expectedRunIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const result = await execution.runBatch([item], `history-${i}`);
			expectedRunIds.push(result.runs[0].runId);
		}
		const first = w.history(item.scriptId, 0, 2);
		expect(first.total).toBe(1);
		expect(first.totalRuns).toBe(3);
		expect(first.nextOffset).toBe(2);
		const second = w.history(item.scriptId, first.nextOffset!, 2);
		expect(second.revisions).toEqual([]);
		expect(second.nextOffset).toBeNull();
		expect([...first.runIds, ...second.runIds].sort()).toEqual(
			expectedRunIds.sort(),
		);
	});
	it("passes document and settings preconditions directly to native execution", async () => {
		const invoke = vi.fn().mockResolvedValue({ result: ok });
		vi.spyOn(runtimeRpc, "getRuntimeRpc").mockReturnValue({
			lifecycleInstanceId: "host",
			invoke,
		} as unknown as ReturnType<typeof runtimeRpc.getRuntimeRpc>);
		const signal = new AbortController().signal;
		const item = { mode: "python" as const, source: "print(1)" };
		expect(
			await runtimeScriptBackend().run(item, target, "operation", signal),
		).toEqual(ok);
		expect(invoke).toHaveBeenCalledExactlyOnceWith(
			"runRhinoScript",
			{ ...item, expectedDocument: target },
			{ operationId: "operation", signal },
		);
	});
	it("pins a revision, persists operation ID and settings, returns old batch after source deletion", async () => {
		const { w, asset, backend, execution, item } = setup();
		const result = await execution.runBatch([item], "session:call");
		expect(result.runs[0]).toMatchObject({
			state: "completed",
			revision: 1,
			scriptId: asset.scriptId,
			settings: { units: "millimeters" },
		});
		expect(backend.run).toHaveBeenCalledWith(
			{ mode: "python", source: "print(1)", echo: undefined },
			target,
			result.runs[0].operationId,
			undefined,
		);
		w.mutate(
			{ action: "delete", scriptId: asset.scriptId, expectedRevision: 1 },
			"delete",
		);
		const replay = await execution.runBatch([item], "session:call");
		expect(replay.replayed).toBe(true);
		expect(replay.runs[0].revision).toBe(1);
		expect(backend.run).toHaveBeenCalledTimes(1);
		await expect(
			execution.runBatch([{ ...item, revision: 2 }], "session:call"),
		).rejects.toThrow("MUTATION_ID_CONFLICT");
		await expect(execution.runBatch([item], "different-call")).rejects.toThrow(
			"SCRIPT_DELETED",
		);
	});
	it("prevalidates the whole mixed batch before executing and respects offline reads", async () => {
		const { w, execution, item, backend } = setup();
		await expect(
			execution.runBatch([item, { mode: "python", source: "" }], "invalid"),
		).rejects.toThrow("INVALID_SCRIPT");
		expect(backend.run).not.toHaveBeenCalled();
		const result = await execution.runBatch([item], "valid");
		const offline = new RhinoScriptExecution(w, () => {
			throw new Error("offline");
		});
		expect(offline.getRun(result.runs[0].runId).state).toBe("completed");
		expect(w.get(item.scriptId).revision).toBe(1);
	});
	it("stops every later mixed item on failure, uncertainty or an abort", async () => {
		for (const failure of [false, true]) {
			const { backend, execution, item } = setup();
			vi.mocked(backend.run).mockImplementationOnce(async () => {
				if (failure) throw new Error("lost result");
				return {
					...ok,
					data: { ok: false, error: "script failed after adding geometry" },
				};
			});
			const items: RunItem[] = [
				item,
				{ mode: "python", source: "print(2)" },
				item,
			];
			const result = await execution.runBatch(items, "call");
			expect(result.runs.map((r) => r.state)).toEqual([
				failure ? "outcome_unknown" : "failed",
				"notRun",
				"notRun",
			]);
			await execution.runBatch(items, "call");
			expect(backend.run).toHaveBeenCalledTimes(1);
		}
	});
	it("never gives a concurrent replay the dispatch claim and keeps the pinned source during edits", async () => {
		const { w, backend, execution, item } = setup();
		let release!: (r: OperationResultSnapshot) => void;
		vi.mocked(backend.run).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const running = execution.runBatch([item, item], "call");
		await vi.waitFor(() => expect(backend.run).toHaveBeenCalledTimes(1));
		w.mutate(
			{
				action: "setSource",
				scriptId: item.scriptId,
				expectedRevision: 1,
				source: "print(2)",
			},
			"edit",
		);
		const replay = await execution.runBatch([item, item], "call");
		expect(replay.runs[0].state).toBe("dispatching");
		expect(replay.runs[1].state).toBe("prepared");
		expect(backend.run).toHaveBeenCalledTimes(1);
		release(ok);
		await running;
		expect(backend.run).toHaveBeenCalledTimes(2);
		expect(vi.mocked(backend.run).mock.calls[1][0].source).toBe("print(1)");
	});
	it("reconciles a terminal retained result without rerunning and refuses a new lifecycle", async () => {
		const { w, backend, execution, item } = setup();
		vi.mocked(backend.run).mockRejectedValue(new Error("timeout"));
		const result = await execution.runBatch([item], "call"),
			runId = result.runs[0].runId;
		const newHost = new RhinoScriptExecution(w, () => ({
			...backend,
			lifecycleInstanceId: "new-host",
		}));
		expect((await newHost.reconcileRun(runId)).state).toBe("outcome_unknown");
		expect(backend.lookup).not.toHaveBeenCalled();
		vi.mocked(backend.lookup).mockResolvedValue({
			state: "terminal",
			result: ok,
		});
		expect((await execution.reconcileRun(runId)).state).toBe("completed");
		expect(backend.run).toHaveBeenCalledTimes(1);
	});
	it("does not dispatch after cancellation while native execution is pending", async () => {
		const { backend, execution, item } = setup(),
			abort = new AbortController();
		vi.mocked(backend.run).mockImplementationOnce(async () => {
			abort.abort();
			return ok;
		});
		const result = await execution.runBatch([item, item], "call", abort.signal);
		expect(result.runs.map((r) => r.state)).toEqual(["completed", "notRun"]);
		expect(backend.run).toHaveBeenCalledTimes(1);
		await expect(
			execution.runBatch([item], "aborted", abort.signal),
		).rejects.toThrow("ABORTED");
	});
	it("reports native completion if final journal write fails and does not run the next item", async () => {
		const { w, backend, execution, item } = setup();
		const original = w.store.write.bind(w.store);
		vi.spyOn(w.store, "write").mockImplementation((id, value) => {
			if ((value as RunRecord).state === "completed")
				throw new Error("disk error");
			return original(id, value);
		});
		const result = await execution.runBatch([item, item], "call");
		expect(result.runs[0]).toMatchObject({
			state: "completed",
			recordingError: expect.stringContaining("disk error"),
		});
		expect(result.runs[1].state).toBe("notRun");
		expect(backend.run).toHaveBeenCalledTimes(1);
		expect(execution.getRun(result.runs[0].runId).state).toBe("dispatching");
	});
	it("reserves run completion space despite a filled source quota and bounds output", async () => {
		const { w, backend, execution, item } = setup(175_000);
		vi.mocked(backend.run).mockImplementationOnce(async () => {
			expect(() =>
				w.mutate(
					{
						action: "setSource",
						scriptId: item.scriptId,
						expectedRevision: 1,
						source: "x".repeat(64_000),
					},
					"fill",
				),
			).toThrow("WORKSPACE_LIMIT_REACHED");
			return { ...ok, data: { ok: true, output: "x".repeat(64_000) } };
		});
		const result = await execution.runBatch([item], "call");
		expect(result.runs[0].state).toBe("completed");
		expect(result.runs[0].output).toHaveLength(6000);
		expect(result.runs[0].outputTruncated).toBe(true);
	});
	it("does not finalize a live prepared owner and never restarts recovered dispatching work", async () => {
		const { w, backend, execution, item } = setup();
		const result = await execution.runBatch([item], "call"),
			runId = result.runs[0].runId;
		const run = execution.getRun(runId);
		writeFileSync(
			join(w.store.directory, runId + ".json"),
			JSON.stringify({
				...run,
				state: "prepared",
				owner: { ...run.owner, processId: "another-live-process" },
			}),
		);
		expect((await execution.reconcileRun(runId)).state).toBe("prepared");
		writeFileSync(
			join(w.store.directory, runId + ".json"),
			JSON.stringify({
				...run,
				state: "dispatching",
				owner: { ...run.owner, pid: 99999999 },
			}),
		);
		expect((await execution.reconcileRun(runId)).state).toBe("outcome_unknown");
		expect(backend.run).toHaveBeenCalledTimes(1);
	});
	it("promotes a known terminal result over a concurrent observer's uncertain journal version", async () => {
		const { w, backend, execution, item } = setup();
		vi.mocked(backend.run).mockImplementationOnce(
			async (_item, _doc, operationId) => {
				const batchId = w.store.list("batch_")[0];
				const batch = w.store.read<{ runs: RunRecord[] }>(batchId);
				const run = execution.getRun(batch.runs[0].runId);
				expect(run.operationId).toBe(operationId);
				// Another process completed a retained-result lookup before the original runner returned.
				w.store.transaction(() =>
					w.store.write(run.runId, {
						...run,
						version: run.version + 1,
						state: "outcome_unknown",
					}),
				);
				return {
					...ok,
					data: {
						ok: false,
						error: { code: "SCRIPT_ERROR", message: "partial geometry exists" },
					},
				};
			},
		);
		const result = await execution.runBatch([item], "race");
		expect(result.runs[0].state).toBe("failed");
		expect(result.runs[0].error).toContain("partial geometry exists");
		expect(execution.getRun(result.runs[0].runId).state).toBe("failed");
	});
	it("classifies native settings precondition rejections as notStarted", async () => {
		for (const code of ["SETTINGS_CHANGED", "DOCUMENT_SETTINGS_CHANGED"]) {
			const { backend, execution, item } = setup();
			vi.mocked(backend.run).mockResolvedValue({
				class: "failed",
				reasonCode: "OPERATION_FAILED",
				message: `${code}: Inspect the new settings`,
			});
			const result = await execution.runBatch([item, item], code);
			expect(result.runs.map((run) => run.state)).toEqual([
				"notStarted",
				"notRun",
			]);
		}
	});
	it("preserves known completion when disk exhaustion also prevents every skipped-item write", async () => {
		const { w, backend, execution, item } = setup();
		vi.mocked(backend.run).mockImplementationOnce(async () => {
			vi.spyOn(w.store, "write").mockImplementation(() => {
				throw new Error("ENOSPC: device full");
			});
			return ok;
		});
		const result = await execution.runBatch([item, item, item], "disk-full");
		expect(backend.run).toHaveBeenCalledTimes(1);
		expect(result.runs.map((run) => run.state)).toEqual([
			"completed",
			"notRun",
			"notRun",
		]);
		expect(result.runs[0].output).toBe("done");
		for (const run of result.runs)
			expect(run.recordingError).toContain("ENOSPC");
		expect(execution.getRun(result.runs[0].runId).state).toBe("dispatching");
		expect(execution.getRun(result.runs[1].runId).state).toBe("prepared");
	});
	it("preserves earlier results when a later dispatch journal fails before source submission", async () => {
		const { w, backend, execution, item } = setup();
		const original = w.store.write.bind(w.store);
		let dispatchCount = 0;
		vi.spyOn(w.store, "write").mockImplementation((id, value) => {
			if ((value as RunRecord).state === "dispatching" && ++dispatchCount === 2)
				throw new Error("ENOSPC: dispatch state");
			return original(id, value);
		});
		const result = await execution.runBatch(
			[item, item, item],
			"dispatch-full",
		);
		expect(result.runs.map((run) => run.state)).toEqual([
			"completed",
			"notStarted",
			"notRun",
		]);
		expect(result.runs[1].recordingError).toContain("ENOSPC");
		expect(backend.run).toHaveBeenCalledTimes(1);
	});
	it("retains uncertainty when native execution's result was replaced by an oversized-result marker", async () => {
		const { backend, execution, item } = setup();
		const marker: OperationResultSnapshot = {
			class: "failed",
			reasonCode: "OPERATION_RESULT_TOO_LARGE",
			message: "Terminal result exceeded transport limit",
		};
		vi.mocked(backend.run).mockResolvedValue(marker);
		vi.mocked(backend.lookup).mockResolvedValue({
			state: "terminal",
			result: marker,
		});
		const result = await execution.runBatch([item, item], "oversized");
		expect(result.runs.map((run) => run.state)).toEqual([
			"outcome_unknown",
			"notRun",
		]);
		expect(result.runs[0].result).toEqual(marker);
		expect(result.runs[0].error).toContain("Inspect Rhino geometry");
		const replay = await execution.runBatch([item, item], "oversized");
		expect(replay.runs.map((run) => run.state)).toEqual([
			"outcome_unknown",
			"notRun",
		]);
		expect(backend.run).toHaveBeenCalledTimes(1);
	});
});
