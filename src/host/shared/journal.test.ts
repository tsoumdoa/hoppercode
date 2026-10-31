import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskJournal, type Submission } from "./journal.js";
import { parseSharedServerMessage } from "../../protocol/browser-messages.js";

vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return { ...fs, rmSync: vi.fn(fs.rmSync) };
});

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "hopper-journal-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "journal.sqlite");
	let journal = new TaskJournal(path);
	cleanup.push(() => journal.close());
	journal.registerSession("conversation", "session");
	return {
		path,
		get journal() {
			return journal;
		},
		reopen() {
			journal.close();
			journal = new TaskJournal(path);
			return journal;
		},
	};
}
function submission(requestId = "request"): Submission {
	return {
		requestId,
		conversationId: "conversation",
		sessionId: "session",
		kind: "prompt",
		text: "Build",
		bindings: [],
		attachments: [],
	};
}

describe("shared task journal foundation", () => {
	it("commits one acceptance and retains identity and receipt after reopening", () => {
		const f = fixture();
		const identity = f.journal.identity;
		const receipt = f.journal.accept(submission());
		expect(f.reopen().identity).toBe(identity);
		expect(f.journal.accept(submission())).toEqual(receipt);
		expect(() =>
			f.journal.accept({ ...submission(), text: "Different" }),
		).toThrow(/conflict/);
		expect(f.journal.snapshot().tasks).toHaveLength(1);
		expect(f.journal.snapshot().events).toHaveLength(1);
	});
	it("rolls back acceptance when the session is not in the conversation", () => {
		const { journal } = fixture();
		expect(() =>
			journal.accept({ ...submission(), conversationId: "other" }),
		).toThrow();
		expect(journal.snapshot().tasks).toHaveLength(0);
		expect(journal.accept(submission()).taskId).toBeTruthy();
		expect(() => journal.registerSession("other", "session")).toThrow(
			/another conversation/,
		);
	});
	it("does not enable an answer before cleanup and creates only one fresh turn", () => {
		const f = fixture(),
			j = f.journal;
		const { taskId, turnId } = j.accept(submission());
		j.start(taskId, turnId);
		const question = j.ask(taskId, turnId, "call", { text: "Which size?" });
		expect(() => j.answer("answer", question, "Large")).toThrow(
			/not answerable/,
		);
		expect(() =>
			j.steer("steer", taskId, "session", turnId, "Small"),
		).toThrow();
		j.confirmSuspension(taskId, turnId);
		const next = j.accept(submission("next"));
		expect(() => j.start(next.taskId, next.turnId)).toThrow(/active/);
		const answer = j.answer("answer", question, "Large");
		expect(answer.turnId).not.toBe(turnId);
		expect(() => j.settle(taskId, turnId, "cancelled")).toThrow(/current/);
		expect(f.reopen().answer("answer", question, "Large")).toEqual(answer);
		expect(() => f.journal.answer("duplicate", question, "Large")).toThrow(
			/not answerable/,
		);
		f.journal.recover();
		expect(f.journal.snapshot().turns.map((t) => t.state)).toEqual([
			"suspended",
			"queued",
			"queued",
		]);
		f.journal.start(taskId, answer.turnId);
		f.reopen().recover();
		expect(f.journal.snapshot().tasks[0].state).toBe("uncertain");
	});
	it("cancellation wins against a late answer", () => {
		const { journal: j } = fixture();
		const { taskId, turnId } = j.accept(submission());
		j.start(taskId, turnId);
		const question = j.ask(taskId, turnId, "call", {});
		j.confirmSuspension(taskId, turnId);
		j.settle(taskId, turnId, "cancelled");
		expect(() => j.answer("late", question, "yes")).toThrow(/not answerable/);
	});
	it("preserves unknown steering delivery and never replays possibly started turns", () => {
		const f = fixture(),
			j = f.journal;
		const { taskId, turnId } = j.accept(submission());
		j.start(taskId, turnId);
		const delivered = j.steer("s1", taskId, "session", turnId, "One");
		j.steer("s2", taskId, "session", turnId, "Two");
		j.markInput(delivered.inputId, "delivering");
		f.reopen().recover();
		expect(f.journal.snapshot().inputs.map((i) => i.state)).toEqual([
			"unknown",
			"not_applied",
		]);
		expect(f.journal.steer("s1", taskId, "session", turnId, "One")).toEqual(
			delivered,
		);
		expect(() => f.journal.start(taskId, turnId)).toThrow();
		f.journal.recover();
		expect(
			f.journal.snapshot().events.filter((e) => e.kind === "recovery_required"),
		).toHaveLength(1);
	});
	it("serializes conversation execution and rejects stale turn steering", () => {
		const { journal: j } = fixture();
		const first = j.accept(submission()),
			second = j.accept(submission("next"));
		expect(() => j.start(second.taskId, second.turnId)).toThrow(/active/);
		j.start(first.taskId, first.turnId);
		expect(() => j.start(second.taskId, second.turnId)).toThrow(/active/);
		expect(() =>
			j.steer("wrong", first.taskId, "other", first.turnId, "x"),
		).toThrow(/session/);
		j.settle(first.taskId, first.turnId, "completed");
		j.start(second.taskId, second.turnId);
		expect(() =>
			j.steer("stale", first.taskId, "session", first.turnId, "x"),
		).toThrow();
	});
	it("does not let a previously suspended turn settle a newer pending question", () => {
		const { journal: j } = fixture();
		const first = j.accept(submission());
		j.start(first.taskId, first.turnId);
		const q = j.ask(first.taskId, first.turnId, "first", {});
		j.confirmSuspension(first.taskId, first.turnId);
		const second = j.answer("answer", q, "yes");
		j.start(second.taskId, second.turnId);
		j.ask(second.taskId, second.turnId, "second", {});
		j.confirmSuspension(second.taskId, second.turnId);
		expect(() => j.settle(first.taskId, first.turnId, "cancelled")).toThrow(
			/current/,
		);
		expect(j.snapshot().tasks[0].state).toBe("awaiting_user");
		j.settle(second.taskId, second.turnId, "cancelled");
	});
});

it("commits a whole reservation set with dispatch and rolls all of it back on conflict", () => {
	const j = new TaskJournal(":memory:");
	j.registerSession("a", "a");
	const binding = {
		kind: "rhino" as const,
		lifecycleInstanceId: "rhino",
		rhinoDocumentId: "doc",
	};
	const a = j.accept({
		requestId: "a",
		conversationId: "a",
		sessionId: "a",
		kind: "prompt",
		text: "save",
		bindings: [binding],
		attachments: [],
	});
	j.start(a.taskId, a.turnId);
	const b = j.delegate({
		parentTaskId: a.taskId, dependencies: [],
		requestId: "b",
		conversationId: "a",
		sessionId: "b",
		kind: "prompt",
		text: "save",
		bindings: [binding],
		attachments: [],
	});
	const owner = (receipt: { taskId: string; turnId: string }) => ({
		taskId: receipt.taskId,
		turnId: receipt.turnId,
		binding,
		attachmentGeneration: "generation",
	});
	j.start(b.taskId, b.turnId, owner(b));
	j.operationIntent({
		taskId: a.taskId,
		turnId: a.turnId,
		name: "runRhinoScript",
		operationClass: "mutation",
		arguments: {},
		deadline: 100,
		owner: owner(a),
		reservations: [{ identity: "path:b", baseline: { exists: false } }],
	});
	expect(() =>
		j.operationIntent({
			taskId: b.taskId,
			turnId: b.turnId,
			name: "runRhinoScript",
			operationClass: "mutation",
			arguments: {},
			deadline: 100,
			owner: owner(b),
			reservations: [
				{ identity: "path:a", baseline: { exists: false } },
				{ identity: "path:b", baseline: { exists: false } },
			],
		}),
	).toThrow();
	expect(j.snapshot().operations).toHaveLength(1);
	expect(j.snapshot().reservations.map((r) => r.destination)).toEqual([
		"path:b",
	]);
});

it("retires old pending authorization submissions on restart while preserving their history", () => {
 const f = fixture();
 const input = submission("old-document-permission");
 const receipt = f.journal.accept(input);
 const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
 const db = new DatabaseSync(f.path);
 try {
  db.prepare("INSERT INTO records VALUES ('admission',?,?,?,'pending')").run(receipt.taskId, receipt.taskId, JSON.stringify({ documentAction: { action: "new" } }));
 } finally { db.close(); }
 f.reopen().recover();
 const snapshot = f.journal.snapshot();
 expect(snapshot.tasks[0]!.state).toBe("failed");
 expect(JSON.parse(String(snapshot.tasks[0]!.payload))).toEqual(input);
 expect(snapshot.records.find(row => row.kind === "admission")!.state).toBe("failed");
 expect(snapshot.events.some(row => String(row.payload).includes("Submit the request again"))).toBe(true);
 expect(snapshot.operations).toHaveLength(0);
});

it("deletes child logs and session files without deleting other threads or replaying requests", async () => {
	const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
	const f = fixture(),
		j = f.journal;
	const other = j.createConversation("other", "Other");
	const input = {
		...submission(),
		bindings: [
			{
				kind: "rhino" as const,
				lifecycleInstanceId: "life",
				rhinoDocumentId: "doc",
			},
		],
	};
	const root = j.accept(input);
	j.start(root.taskId, root.turnId);
	const child = j.delegate({
		...input,
		requestId: "child",
		parentTaskId: root.taskId,
		sessionId: "worker",
		dependencies: [],
	});
	j.start(child.taskId, child.turnId);
	j.publish(child.taskId, {
		type: "messages",
		turnId: child.turnId,
		messages: [{ text: "private transcript" }],
	});
	j.settle(child.taskId, child.turnId, "completed");
	j.settle(root.taskId, root.turnId, "completed");
	const folder = join(f.path, "..", "sessions", "conversation");
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "session.jsonl"), "private transcript");
	j.manageConversation("archive", "conversation", "archive_conversation");
	// A thread restored after the preview invalidates the entire batch.
	j.manageConversation("archive-other", other.conversationId, "archive_conversation");
	j.manageConversation("restore-other", other.conversationId, "unarchive_conversation");
	expect(() => j.purgeArchivedConversations("stale", ["conversation", other.conversationId], null)).toThrow(/changed/);
	expect(j.getTask(root.taskId)).toBeDefined();
	expect(existsSync(folder)).toBe(true);
	const remove = vi.mocked(rmSync), original = remove.getMockImplementation()!;
	remove.mockImplementation((path, options) => {
		if (path === folder) throw Object.assign(new Error("Directory locked"), { code: "EACCES" });
		return original(path, options);
	});
	try {
		const result = j.purgeArchivedConversations("delete", ["conversation"], null);
		expect(result.cleanupPending).toBe(1);
		expect(parseSharedServerMessage(JSON.stringify({ type: "command_accepted", result })))
			.toMatchObject({ result: { conversationIds: ["conversation"], cleanupPending: 1 } });
		expect(f.reopen().getTask(root.taskId)).toBeUndefined();
		expect(existsSync(folder)).toBe(true);
	} finally { remove.mockImplementation(original); }
	const reopened = f.reopen();
	expect(existsSync(folder)).toBe(false);
	expect(reopened.snapshot().tasks).toEqual([]);
	expect(reopened.snapshot().sessions.map((row) => row.conversation_id)).toEqual([
		other.conversationId,
	]);
	expect(() => reopened.accept(input)).toThrow(/deleted/);
	// Retrying the completed purge must not include a newly archived thread.
	reopened.manageConversation("archive-other-again", other.conversationId, "archive_conversation");
	reopened.purgeArchivedConversations("delete", ["conversation"], null);
	expect(
		f
			.reopen()
			.browserSnapshot()
			.conversations.map((row) => row.id),
	).toEqual([other.conversationId]);
});

it("migrates version five without losing history and never reuses the epoch watermark after deletion", () => {
	const f = fixture(),
		j = f.journal;
	const a = j.accept(submission());
	j.start(a.taskId, a.turnId);
	j.settle(a.taskId, a.turnId, "completed");
	const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
	const db = new DatabaseSync(f.path);
	db.exec(
		"DROP TRIGGER conversation_created; DROP TABLE conversation_sequence; DROP TABLE deleted_conversation_files; ALTER TABLE conversations DROP COLUMN archived_at; ALTER TABLE conversations DROP COLUMN document_label; PRAGMA user_version=5;",
	);
	db.close();
	const migrated = f.reopen();
	expect(migrated.snapshot().tasks[0]?.id).toBe(a.taskId);
	const sequence = migrated.lastConversationSequence;
	migrated.manageConversation("delete", "conversation", "delete_conversation");
	const next = migrated.createConversation("new-chat", "New chat");
	expect(
		migrated.browserSnapshot({ afterConversationSequence: sequence }).history
			.conversationId,
	).toBe(next.conversationId);
});
