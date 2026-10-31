import { describe, it, expect, vi } from "vitest";
import { TaskJournal } from "./journal.js";
import {
	SharedTaskService,
	type DriverContext,
	type TaskDriver,
} from "./task-service.js";
import type { TargetBinding } from "../../protocol/shared-execution.js";
const binding = (id: string): TargetBinding => ({
	kind: "rhino",
	lifecycleInstanceId: id,
	rhinoDocumentId: "doc",
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function setup(maxWorkers?: number) {
	const journal = new TaskJournal(":memory:");
	const contexts: DriverContext[] = [],
		finish = new Map<string, () => void>(),
		clean = new Map<string, (confirmed?: boolean) => void>();
	const service = new SharedTaskService(journal, {
		maxWorkers,
		resolveBinding: (b) => ({
			processKey: b.lifecycleInstanceId,
			attachmentGeneration: "generation",
		}),
		validateBinding: () => {},
		createDriver: (context) => {
			contexts.push(context);
			return {
				run: () =>
					new Promise<void>((resolve) => finish.set(context.taskId, resolve)),
				steer: async () => {},
				cancel: () => {
					finish.get(context.taskId)?.();
				},
				cleanup: () =>
					new Promise((resolve) =>
						clean.set(context.taskId, (confirmed = true) => resolve({ confirmed })),
					),
			} satisfies TaskDriver;
		},
	});
	function submit(
		conversation: string,
		target: string,
		request = conversation,
	) {
		journal.registerSession(conversation, conversation);
		return service.submit({
			requestId: request,
			conversationId: conversation,
			sessionId: conversation,
			kind: "prompt",
			text: "edit",
			bindings: [binding(target)],
			attachments: [],
		});
	}
	return { journal, service, contexts, finish, clean, submit };
}
describe("shared scheduling", () => {
	it.each([false, true])("retains steering during initialization and respects cancellation=%s", async (cancelled) => {
		const journal = new TaskJournal(":memory:");
		const chat = journal.createConversation("chat", "Chat");
		let initialize!: (driver: TaskDriver) => void;
		let finish!: () => void;
		const steer = vi.fn(async (_payload: unknown, _inputId?: number) => {});
		const service = new SharedTaskService(journal, {
			resolveBinding: () => ({ processKey: "p", attachmentGeneration: "g" }), validateBinding: () => {},
			createDriver: () => new Promise(resolve => { initialize = resolve; }),
		});
		const task = service.submit({ ...chat, requestId: "task", kind: "prompt", text: "Edit", bindings: [], attachments: [] });
		try {
			await tick();
			const first = service.steer("first", task.taskId, chat.sessionId, task.turnId, { text: "10 mm" });
			service.steer("second", task.taskId, chat.sessionId, task.turnId, { text: "Make it blue" });
			await tick();
			expect(steer).not.toHaveBeenCalled();
			if (cancelled) await service.cancel(task.taskId);
			initialize({ run: () => new Promise(resolve => { finish = resolve; }), steer, cancel: () => {}, cleanup: async () => ({ confirmed: true }) });
			if (cancelled) {
				await expect.poll(() => journal.getTask(task.taskId)?.state).toBe("cancelled");
				expect(steer).not.toHaveBeenCalled();
				expect(journal.snapshot().inputs.map(row => row.state)).toEqual(["not_applied", "not_applied"]);
			} else {
				await expect.poll(() => journal.snapshot().inputs.map(row => row.state)).toEqual(["applied", "applied"]);
				expect(steer.mock.calls.map(call => call[0])).toEqual([{ text: "10 mm" }, { text: "Make it blue" }]);
				expect(service.steer("first", task.taskId, chat.sessionId, task.turnId, { text: "10 mm" })).toEqual(first);
				await tick();
				expect(steer).toHaveBeenCalledTimes(2);
				finish();
				await expect.poll(() => journal.getTask(task.taskId)?.state).toBe("completed");
			}
		} finally { finish?.(); await service.stop(); journal.close(); }
	});
	it.each([true, false])("schedules a second document according to confirmed cleanup (%s), even after a greeting with no native calls", async (confirmed) => {
		const s = setup();
		const first = s.submit("first", "p");
		await tick();
		s.finish.get(first.taskId)!();
		await tick();
		s.clean.get(first.taskId)!(confirmed);
		await tick();
		s.journal.registerSession("second", "second");
		const second = s.service.submit({
			requestId: "second",
			conversationId: "second",
			sessionId: "second",
			kind: "prompt",
			text: "model hello world",
			bindings: [{ kind: "rhino", lifecycleInstanceId: "p", rhinoDocumentId: "doc-2" }],
			attachments: [],
		});
		await tick();
		expect(s.journal.snapshot().operations).toHaveLength(0);
		expect(s.journal.snapshot().tasks.find((task) => task.id === second.taskId)?.state).toBe(confirmed ? "running" : "queued");
		if (!confirmed) {
			const record = s.journal.snapshot().records.find((record) => record.kind === "scheduling" && record.task_id === second.taskId)!;
			expect(JSON.parse(String(record.payload))).toEqual({
				reason: expect.stringContaining("Waiting for recovery of an earlier task in this Rhino instance."),
				blockingTaskId: first.taskId,
			});
			const events = s.journal.snapshot().events.filter((event) => event.task_id === second.taskId && event.kind === "task_waiting_for_target");
			expect(JSON.parse(String(events[0]!.payload))).toMatchObject({ blockingTaskId: first.taskId });
			s.service.pump();
			expect(s.journal.snapshot().events.filter((event) => event.task_id === second.taskId && event.kind === "task_waiting_for_target")).toHaveLength(events.length);
			await s.service.cancel(second.taskId);
		} else {
			s.finish.get(second.taskId)!();
			await tick();
			s.clean.get(second.taskId)!();
			await tick();
		}
		s.journal.close();
	});
	it("persists question before cleanup and answers into one fresh turn", async () => {
		const s = setup(),
			a = s.submit("a", "p");
		await tick();
		const q = s.contexts[0]!.ask("call", { prompt: "Choose" });
		expect(() => s.service.answer("answer", q, "yes")).toThrow(
			"not answerable",
		);
		s.finish.get(a.taskId)!();
		await tick();
		s.clean.get(a.taskId)!();
		await tick();
		const answer = s.service.answer("answer", q, "yes");
		expect(answer.turnId).not.toBe(a.turnId);
		expect(s.service.answer("answer", q, "yes")).toEqual(answer);
		await tick();
		expect(s.contexts).toHaveLength(2);
		expect(s.contexts[1]!.continuation).toMatchObject({ answer: "yes" });
	});
	it("cancellation wins over question answers and waits for cleanup", async () => {
		const s = setup(),
			a = s.submit("a", "p");
		await tick();
		const q = s.contexts[0]!.ask("call", {});
		await s.service.cancel(a.taskId);
		await tick();
		expect(() => s.service.answer("x", q, {})).toThrow();
		expect(s.service.snapshot().tasks[0]!.state).toBe("suspending");
		s.clean.get(a.taskId)!();
		await tick();
		expect(s.service.snapshot().tasks[0]!.state).toBe("cancelled");
	});
	it("unknown native outcome blocks same-process work despite successful cleanup", async () => {
		const s = setup(),
			a = s.submit("a", "p");
		await tick();
		s.journal.operationIntent({
			taskId: a.taskId,
			turnId: a.turnId,
			name: "runRhinoScript",
			operationClass: "mutation",
			arguments: {},
			deadline: 100,
		});
		s.finish.get(a.taskId)!();
		await tick();
		s.clean.get(a.taskId)!();
		await tick();
		expect(s.service.snapshot().tasks[0]!.state).toBe("uncertain");
		const b = s.submit("b", "p");
		expect(s.contexts.map((c) => c.taskId)).not.toContain(b.taskId);
		expect(() =>
			s.journal.recoveryDisposition("recovery", a.taskId, {
				acknowledged: true,
				inspectedBaseline: {},
			}),
		).toThrow();
		s.journal.recoveryDisposition("recovery", a.taskId, {
			acknowledged: true,
			originalProcessExited: true,
			inspectedBaseline: {},
		});
		s.service.releaseRecovered(a.taskId);
		await tick();
		expect(s.contexts.map((c) => c.taskId)).toContain(b.taskId);
		expect(s.service.snapshot().operations[0]!.state).toBe("dispatched");
	});
	it("deduplicates accepted work before invoking a model", async () => {
		const s = setup(),
			a = s.submit("a", "p");
		expect(s.submit("a", "p")).toEqual(a);
		await tick();
		expect(s.contexts).toHaveLength(1);
	});
});

it("stop waits for confirmed driver cleanup before the journal can close", async () => {
	const s = setup(),
		receipt = s.submit("a", "p");
	await tick();
	let stopped = false;
	const stop = s.service.stop().then(() => {
		stopped = true;
	});
	await tick();
	expect(stopped).toBe(false);
	s.clean.get(receipt.taskId)!();
	await stop;
	expect(stopped).toBe(true);
	expect(s.journal.snapshot().tasks[0]!.state).toBe("cancelled");
	s.journal.close();
});
it("a coordinator question does not wait for a running child", async () => {
	const s = setup();
	s.journal.registerSession("root", "root");
	const root = s.service.submit({
		requestId: "root",
		conversationId: "root",
		sessionId: "root",
		kind: "prompt",
		text: "coordinate",
		bindings: [binding("p"), binding("q")],
		attachments: [],
	});
	await tick();
	const child = s.service.delegate({
		requestId: "child",
		conversationId: "root",
		sessionId: "worker",
		parentTaskId: root.taskId,
		dependencies: [],
		kind: "prompt",
		text: "work",
		bindings: [binding("p")],
		attachments: [],
	});
	await tick();
	s.contexts
		.find((c) => c.taskId === root.taskId)!
		.ask("root-question", { text: "Choose" });
	s.finish.get(root.taskId)!();
	await tick();
	expect(s.clean.has(root.taskId)).toBe(true);
	s.clean.get(root.taskId)!();
	await tick();
	expect(
		s.service.snapshot().tasks.find((t) => t.id === root.taskId)!.state,
	).toBe("awaiting_user");
	expect(
		s.service.snapshot().tasks.find((t) => t.id === child.taskId)!.state,
	).toBe("running");
});

it("enforces the combined root and child budget at delegation and queued dispatch after service recreation", () => {
	const journal = new TaskJournal(":memory:");
	journal.registerSession("a", "a");
	const submission = { requestId: "root", conversationId: "a", sessionId: "a",
		kind: "prompt" as const, text: "work", bindings: [binding("p")], attachments: [] };
	const root = journal.accept(submission);
	journal.start(root.taskId, root.turnId);
	const childInput = { ...submission, requestId: "child", sessionId: "worker",
		parentTaskId: root.taskId, dependencies: [] };
	const child = journal.delegate(childInput);
	journal.start(child.taskId, child.turnId);
	const queued = journal.delegate({ ...childInput, requestId: "queued", sessionId: "queued-worker" });
	journal.recordUsage(root.taskId, root.turnId, 4);
	journal.recordUsage(child.taskId, child.turnId, 6);
	journal.settle(child.taskId, child.turnId, "completed");
	const createDriver = vi.fn(() => { throw new Error("must not start"); });
	const service = new SharedTaskService(journal, {
		maxUsage: 10, createDriver,
		resolveBinding: () => ({ processKey: "p", attachmentGeneration: "g" }),
		validateBinding: () => {},
	});
	try {
		expect(() => service.delegate({ ...childInput, requestId: "over-budget", sessionId: "extra" })).toThrow("Model usage budget exhausted");
		service.pump();
		expect(journal.snapshot().tasks.find((task) => task.id === queued.taskId)?.state).toBe("failed");
		expect(createDriver).not.toHaveBeenCalled();
	} finally { journal.close(); }
});
it("terminalizes a queued child whose dependency becomes uncertain", async () => {
	const s = setup();
	s.journal.registerSession("root", "root");
	const root = s.service.submit({
		requestId: "root",
		conversationId: "root",
		sessionId: "root",
		kind: "prompt",
		text: "coordinate",
		bindings: [binding("p"), binding("q")],
		attachments: [],
	});
	await tick();
	const first = s.service.delegate({
		requestId: "first",
		conversationId: "root",
		sessionId: "first-worker",
		parentTaskId: root.taskId,
		dependencies: [],
		kind: "prompt",
		text: "first",
		bindings: [binding("p")],
		attachments: [],
	});
	await tick();
	const second = s.service.delegate({
		requestId: "second",
		conversationId: "root",
		sessionId: "second-worker",
		parentTaskId: root.taskId,
		dependencies: [first.taskId],
		kind: "prompt",
		text: "second",
		bindings: [binding("q")],
		attachments: [],
	});
	s.journal.operationIntent({
		taskId: first.taskId,
		turnId: first.turnId,
		name: "runRhinoScript",
		operationClass: "mutation",
		arguments: {},
		deadline: 100,
	});
	s.finish.get(first.taskId)!();
	await tick();
	s.clean.get(first.taskId)!();
	await tick();
	const children = await s.service.waitForChildren(root.taskId);
	expect(children.tasks.map((task) => task.state)).toEqual([
		"uncertain",
		"failed",
	]);
	expect(s.contexts.some((context) => context.taskId === second.taskId)).toBe(
		false,
	);
});
it("queues root follow-ups without starving delegated geometry workers", async () => {
	const journal = new TaskJournal(":memory:"),
		started: string[] = [];
	const service = new SharedTaskService(journal, {
		maxCoordinators: 1,
		maxWorkers: 1,
		resolveBinding: (b) => ({
			processKey: b.lifecycleInstanceId,
			attachmentGeneration: "g",
		}),
		validateBinding: () => {},
		createDriver: (context) => {
			started.push(context.taskId);
			return {
				run: () => new Promise<void>(() => {}),
				steer: async () => {},
				cancel: () => {},
				cleanup: async () => ({ confirmed: true }),
			};
		},
	});
	const submit = (id: string, bindings: TargetBinding[]) => {
		journal.registerSession("a", "a");
		return service.submit({
			requestId: id,
			conversationId: "a",
			sessionId: "a",
			kind: "prompt",
			text: "Work",
			bindings,
			attachments: [],
		});
	};
	const a = submit("a", [binding("p"), binding("q")]),
		b = submit("b", []),
		c = service.delegate({ requestId: "c", conversationId: "a", sessionId: "worker-c", parentTaskId: a.taskId, dependencies: [], kind: "prompt", text: "Work", bindings: [binding("p")], attachments: [] });
	await tick();
	expect(started).toEqual([a.taskId, c.taskId]);
	expect(
		journal.snapshot().tasks.find((task) => task.id === b.taskId)?.state,
	).toBe("queued");
});
it("keeps failed driver initialization uncertain when native cleanup was not confirmed", async () => {
	const journal = new TaskJournal(":memory:");
	journal.registerSession("a", "a");
	const service = new SharedTaskService(journal, {
		resolveBinding: () => ({ processKey: "p", attachmentGeneration: "g" }),
		validateBinding: () => {},
		createDriver: () => {
			throw Object.assign(new Error("Setup failed"), {
				cleanupConfirmed: false,
			});
		},
	});
	service.submit({
		requestId: "a",
		conversationId: "a",
		sessionId: "a",
		kind: "prompt",
		text: "Work",
		bindings: [binding("p")],
		attachments: [],
	});
	await tick();
	expect(journal.snapshot().tasks[0]?.state).toBe("uncertain");
	journal.close();
});

it("keeps ownership of the selected document while delegating to another instance", async () => {
	const s = setup();
	s.journal.registerSession("conversation", "session");
	const first = binding("first"), second = binding("second"), forbidden = binding("third");
	const root = s.service.submit({ requestId: "root", conversationId: "conversation", sessionId: "session", kind: "prompt", text: "Compare these models", bindings: [first, second], messageTarget: second, attachments: [] });
	await tick();
	expect(s.contexts[0]).toMatchObject({ binding: second, messageTarget: second, accessibleBindings: [first, second], owner: { binding: second } });
	const child = { requestId: "child", parentTaskId: root.taskId, dependencies: [], conversationId: "conversation", sessionId: "worker", kind: "prompt" as const, text: "Read first model", bindings: [first], attachments: [] };
	s.service.delegate(child);
	await tick();
	expect(s.contexts[1]).toMatchObject({ binding: first, accessibleBindings: [first] });
	expect(() => s.service.delegate({ ...child, requestId: "forbidden", sessionId: "other-worker", bindings: [forbidden] })).toThrow("Child binding is not authorized");
});

it("cancels a main task while it waits for a child to free its model slot", async () => {
	const s = setup(1);
	s.journal.registerSession("conversation", "session");
	const selected = binding("selected"), other = binding("other");
	const root = s.service.submit({ requestId: "root", conversationId: "conversation", sessionId: "session", kind: "prompt", text: "Compare", bindings: [selected, other], messageTarget: selected, attachments: [] });
	await tick();
	const child = s.service.delegate({ requestId: "child", parentTaskId: root.taskId, dependencies: [], conversationId: "conversation", sessionId: "worker", kind: "prompt", text: "Inspect", bindings: [other], attachments: [] });
	const waiting = s.service.waitForChildren(root.taskId);
	const rejected = expect(waiting).rejects.toThrow("cancelled");
	await tick();
	expect(s.contexts).toHaveLength(2);
	await s.service.cancel(root.taskId);
	await rejected;
	await tick();
	s.clean.get(child.taskId)!();
	s.clean.get(root.taskId)!();
	await tick();
	expect(s.journal.snapshot().tasks.every((task) => task.state === "cancelled")).toBe(true);
	s.journal.close();
});
