import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { TaskJournal } from "./journal.js";
import { SharedTaskService, type DriverContext } from "./task-service.js";
import { DocumentActionService } from "./document-actions.js";
import { GeometryTransferService } from "./transfer.js";
import type { TargetBinding } from "../../protocol/shared-execution.js";
const binding = (document: string): TargetBinding => ({
	kind: "rhino",
	lifecycleInstanceId: "rhino",
	rhinoDocumentId: document,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});
describe("managed document and artifact actions", () => {
	it("hands off once and keeps the new document through repeated answers after the original closes", async () => {
		const journal = new TaskJournal(":memory:");
		journal.registerSession("conversation", "session");
		let grants: DocumentActionService;
		let question = "", generation = "gen", originalClosed = false;
		const contexts: DriverContext[] = [];
		const order: string[] = [];
		const scheduler = new SharedTaskService(journal, {
			resolveBinding: target => {
				if (originalClosed && target.kind === "rhino" && target.rhinoDocumentId === "old") throw new Error("Original document closed");
				return { processKey: "process", attachmentGeneration: generation };
			},
			resolveLifecycle: () => ({
				processKey: "process",
				attachmentGeneration: "gen",
			}),
			validateBinding: () => {},
			createDriver: (context) => {
				contexts.push(context);
				return {
					run: async () => {
						order.push("run:" + context.binding?.kind + ":" + context.turnId);
						if (contexts.length === 1) {
							const grant = grants.prepare({
								requestId: "new-document",
								taskId: context.taskId,
								lifecycleInstanceId: "rhino",
								kind: "rhino",
								action: "new",
								modifiedPolicy: "refuse",
							});
							context.requestDocumentAction(grant.grantId);
						} else if (contexts.length < 4) question = context.ask(`question-${contexts.length}`, { question: "What size?" });
					},
					steer: async () => {},
					cancel: () => {},
					cleanup: async () => {
						order.push("cleanup");
						return { confirmed: true };
					},
				};
			},
		});
		grants = new DocumentActionService(journal, scheduler, {
			preflight: async () => ({ destinations: [] }),
			execute: async (owner) => {
				order.push("action");
				originalClosed = true;
				expect(owner.grantId).toMatch(/^grant-/);
				return { binding: binding("new"), result: { created: true } };
			},
			verify: async () => {},
		});
		scheduler.setDocumentActionExecutor((id) => grants.execute(id));
		const receipt = scheduler.submit({
			requestId: "prompt",
			conversationId: "conversation",
			sessionId: "session",
			kind: "prompt",
			text: "new model",
			bindings: [binding("old")],
			attachments: [],
		});
		try {
			for (let index = 0; index < 2; index++) {
				await expect.poll(() => journal.getTask(receipt.taskId)?.state).toBe("awaiting_user");
				generation = `reattached-${index}`;
				scheduler.answer(`answer-${index}`, question, "10 mm");
			}
			await expect.poll(() => journal.getTask(receipt.taskId)?.state).toBe("completed");
			const state = journal.snapshot();
			expect(state.tasks[0]!.state).toBe("completed");
			expect(state.turns.map((t) => t.state)).toEqual([
				"suspended",
				"completed",
				"suspended",
				"suspended",
				"completed",
			]);
			expect(contexts.map(context => context.binding)).toEqual([binding("old"), binding("new"), binding("new"), binding("new")]);
			expect(contexts.at(-1)?.owner?.attachmentGeneration).toBe("reattached-1");
			expect(contexts[1]!.turnId).not.toBe(receipt.turnId);
			expect(order.indexOf("cleanup")).toBeLessThan(order.indexOf("action"));
			expect(JSON.parse(String(state.tasks[0]!.payload)).bindings).toEqual([
				binding("old"),
			]);
			expect(journal.authorizationAdditions(receipt.taskId)).toEqual([
				binding("new"),
			]);
		} finally { await scheduler.stop(); journal.close(); }
	});
	it("publishes one retained artifact and never duplicates an import after loss of evidence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hopper-transfer-"));
		directories.push(directory);
		const journal = new TaskJournal(":memory:");
		journal.registerSession("conversation", "session");
		let finish!: () => void;
		const scheduler = new SharedTaskService(journal, {
			resolveBinding: () => ({
				processKey: "process",
				attachmentGeneration: "gen",
			}),
			validateBinding: () => {},
			createDriver: () => ({
				run: () =>
					new Promise<void>((resolve) => {
						finish = resolve;
					}),
				steer: async () => {},
				cancel: () => finish(),
				cleanup: async () => ({ confirmed: true }),
			}),
		});
		const receipt = scheduler.submit({
			requestId: "task",
			conversationId: "conversation",
			sessionId: "session",
			kind: "prompt",
			text: "transfer",
			bindings: [binding("a"), binding("b")],
			attachments: [],
		});
		await tick();
		let exports = 0,
			imports = 0;
		const transfer = new GeometryTransferService(
			journal,
			scheduler,
			directory,
			{
				export: async (_owner, input) => {
					exports++;
					await writeFile(input.path, Buffer.from("fake-3dm-fixture"));
					return {
						units: "Millimeters",
						objectIds: ["source"],
						absoluteTolerance: 0.01,
						objectTypes: ["Brep"],
						byteLength: 16,
						createdAt: Date.now(),
					};
				},
				import: async (_owner, input) => {
					imports++;
					expect(input.scale).toBe(0.001);
					expect(await readFile(input.path, "utf8")).toBe("fake-3dm-fixture");
					throw new Error("lost result");
				},
			},
		);
		const artifact = await transfer.export({
			requestId: "export",
			taskId: receipt.taskId,
			source: binding("a"),
			objectIds: ["source"],
		});
		expect(
			await transfer.export({
				requestId: "export",
				taskId: receipt.taskId,
				source: binding("a"),
				objectIds: ["source"],
			}),
		).toEqual(artifact);
		expect(exports).toBe(1);
		const request = {
			requestId: "import",
			taskId: receipt.taskId,
			artifactId: artifact.artifactId,
			destination: binding("b"),
			destinationUnits: "Meters",
		};
		await expect(transfer.import(request)).rejects.toThrow("lost result");
		await expect(transfer.import(request)).rejects.toThrow("reconciliation");
		expect(imports).toBe(1);
		expect(
			journal.snapshot().records.find((r) => r.kind === "artifact")!.state,
		).toBe("published");
		finish();
		await tick();
		expect(journal.snapshot().tasks[0]!.state).toBe("uncertain");
	});
});
