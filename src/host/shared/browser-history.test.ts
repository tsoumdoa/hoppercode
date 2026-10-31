import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TaskJournal } from "./journal.js";

const submit = (journal: TaskJournal, conversation: { conversationId: string; sessionId: string }, requestId: string) =>
	journal.accept({ ...conversation, requestId, kind: "prompt", text: requestId, bindings: [], attachments: [] });

it("keeps interrupted child tasks reachable across host sessions and history pages until recovery", () => {
	const journal = new TaskJournal(":memory:");
	try {
		const old = journal.createConversation("old", "Interrupted chat");
		const finished = journal.createConversation("finished", "Finished chat");
		const binding = { kind: "rhino" as const, lifecycleInstanceId: "life", rhinoDocumentId: "doc" };
		const input = { ...old, kind: "prompt" as const, text: "Edit", bindings: [binding], attachments: [] };
		const root = journal.accept({ ...input, requestId: "root" });
		journal.start(root.taskId, root.turnId);
		const child = journal.delegate({ ...input, requestId: "child", sessionId: "worker-child", parentTaskId: root.taskId, dependencies: [] });
		journal.start(child.taskId, child.turnId, { taskId: child.taskId, turnId: child.turnId, binding, attachmentGeneration: "old" });
		journal.settle(root.taskId, root.turnId, "completed");
		journal.recover();
		for (let index = 0; index < 25; index++) submit(journal, old, `queued-${index}`);
		const afterConversationSequence = journal.lastConversationSequence;
		const fresh = journal.createConversation("fresh", "Fresh chat");
		const overview = journal.browserSnapshot({ afterConversationSequence });
		expect(overview.conversations.map(row => [row.id, row.recovery_required])).toEqual(expect.arrayContaining([[old.conversationId, 1], [fresh.conversationId, 0], [finished.conversationId, 0]]));
		expect(JSON.parse(String(overview.conversations.find(row => row.id === old.conversationId)!.instance_ids))).toContain("life");
		expect(JSON.parse(String(overview.conversations.find(row => row.id === old.conversationId)!.recovery_instance_ids))).toEqual(["life"]);
		expect(JSON.parse(String(overview.conversations.find(row => row.id === fresh.conversationId)!.recovery_instance_ids))).toEqual([]);
		expect(overview.history.conversationId).toBe(fresh.conversationId);
		const selected = journal.browserSnapshot({ afterConversationSequence, conversationId: old.conversationId });
		expect(selected.tasks.find(row => row.id === child.taskId)?.state).toBe("uncertain");
		expect(selected.history.pageTaskIds).toContain(child.taskId);
		expect(selected.history.pageTaskIds).toContain(root.taskId);
		journal.recoveryDisposition("recover", child.taskId, { acknowledged: true, originalProcessExited: true, inspectedBaseline: {} });
		const recovered = journal.browserSnapshot({ afterConversationSequence, conversationId: old.conversationId });
		expect(recovered.history.conversationId).toBe(old.conversationId);
		expect(recovered.conversations.find(row => row.id === old.conversationId)?.recovery_required).toBe(0);
		expect(journal.browserSnapshot({ afterConversationSequence }).conversations.map(row => row.id)).toEqual(expect.arrayContaining([old.conversationId, fresh.conversationId, finished.conversationId]));
	} finally { journal.close(); }
});

it("preserves interrupted assistant messages and tool arguments without a final message list", () => {
	const journal = new TaskJournal(":memory:");
	try {
		const conversation = journal.createConversation("chat", "Chat");
		const { taskId, turnId } = submit(journal, conversation, "request");
		journal.start(taskId, turnId);
		const agent = (event: unknown) => journal.publish(taskId, { type: "agent_event", turnId, event });
		agent({ type: "message_start", message: { role: "assistant", content: [] } });
		agent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Thinking" } });
		agent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Partial" } });
		agent({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, toolCall: { type: "toolCall", id: "call", name: "bash", arguments: { command: "work" } } } });
		journal.settle(taskId, turnId, "cancelled");
		const projected = journal.browserSnapshot().events;
		expect(projected).toHaveLength(1);
		expect(JSON.parse(String(projected[0].payload)).message.content).toEqual([
			{ type: "thinking", thinking: "Thinking" }, { type: "text", text: "Partial" },
			{ type: "toolCall", id: "call", name: "bash", arguments: { command: "work" } },
		]);
	} finally { journal.close(); }
});

it("pages completed roots, retains active tasks for controls, and excludes other conversations' content", () => {
	const journal = new TaskJournal(":memory:");
	try {
		const conversation = journal.createConversation("chat", "Chat");
		const ids: string[] = [];
		for (let i = 0; i < 45; i++) {
			const { taskId, turnId } = submit(journal, conversation, `request-${i}`);
			journal.start(taskId, turnId);
			journal.publish(taskId, { type: "messages", turnId, messages: [{ text: `message-${i}` }] });
			journal.settle(taskId, turnId, "completed"); ids.push(taskId);
		}
		const other = journal.createConversation("other", "Other");
		const hidden = submit(journal, other, "other-request");
		journal.start(hidden.taskId, hidden.turnId);
		journal.publish(hidden.taskId, { type: "messages", turnId: hidden.turnId, messages: [{ text: "hidden-content" }] });
		journal.settle(hidden.taskId, hidden.turnId, "completed");
		const active = submit(journal, conversation, "active");
		journal.start(active.taskId, active.turnId);
		const latest = journal.browserSnapshot({ conversationId: conversation.conversationId });
		expect(latest.history.hasOlder).toBe(true);
		expect(latest.history.pageTaskIds).toHaveLength(20);
		expect(latest.tasks.at(-1)!.id).toBe(active.taskId);
		expect(JSON.stringify(latest.events)).not.toContain("hidden-content");
		const older = journal.browserSnapshot({ conversationId: conversation.conversationId, before: Number(latest.history.oldestSequence) });
		expect(older.history.pageTaskIds).toHaveLength(20);
		expect(older.history.pageTaskIds.some(id => latest.history.pageTaskIds.includes(id))).toBe(false);
		expect(older.tasks.some(task => task.id === active.taskId)).toBe(true);
		expect(older.history.pageTaskIds).not.toContain(active.taskId);
		const first = journal.browserSnapshot({ conversationId: conversation.conversationId, before: Number(older.history.oldestSequence) });
		expect(first.history.hasOlder).toBe(false);
		expect(first.history.pageTaskIds).toEqual(ids.slice(0, 6));
		expect(journal.snapshot().tasks).toHaveLength(47);
	} finally { journal.close(); }
});

it("rebuilds the projection from an existing journal and keeps it consistent after reopening", () => {
	const directory = mkdtempSync(join(tmpdir(), "hopper-history-"));
	const path = join(directory, "journal.sqlite");
	let journal = new TaskJournal(path);
	try {
		const conversation = journal.createConversation("chat", "Chat");
		const { taskId, turnId } = submit(journal, conversation, "request");
		journal.publish(taskId, { type: "messages", turnId, messages: [{ text: "Saved" }] });
		const expected = journal.browserSnapshot();
		journal.close();
		const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
		const db = new DatabaseSync(path);
		db.exec("DROP TABLE browser_events; DROP TABLE browser_history_cursor;"); db.close();
		journal = new TaskJournal(path);
		expect(journal.browserSnapshot()).toEqual(expected);
		journal.close(); journal = new TaskJournal(path);
		expect(journal.browserSnapshot()).toEqual(expected);
	} finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});
