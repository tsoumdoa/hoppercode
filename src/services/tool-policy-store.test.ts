import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolPolicyStore } from "./tool-policy-store.js";
import { ToolCredentials, type ProtectedCredentialBackend } from "./tool-credentials.js";
import { publishPluginCredential, type ToolPolicyDescriptor } from "./tool-policy.js";

const inventory: ToolPolicyDescriptor[] = [{ id: "test", name: "test", owner: "hopper", parent: "hopper.rhino", defaultActive: true, requirements: [] }];
const directories: string[] = [];
const stores: ToolPolicyStore[] = [];
async function create() {
	const directory = await mkdtemp(join(tmpdir(), "hopper-policy-"));
	directories.push(directory);
	const store = new ToolPolicyStore(inventory, { directory });
	stores.push(store);
	return store;
}
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("authoritative policy persistence", () => {
	it("migrates catalog additions once and retains opt-outs across mixed catalogs", async () => {
		const original = await create();
		await original.update(await original.read(), { target: "tools", id: "test", enabled: false });
		await original.update(await original.read(), { target: "parents", id: "hopper.rhino", enabled: false });
		await original.transition(current => publishPluginCredential(current, { ...current, generation: 0 }, "00000000-0000-4000-8000-000000000001", false, "firecrawl"));
		const before = await original.read();
		const added = { ...inventory[0], id: "next", name: "next" };
		const newer = new ToolPolicyStore([...inventory, added], { directory: original.directory });
		const retired = new ToolPolicyStore([added], { directory: original.directory });
		stores.push(newer, retired);
		const migrated = await newer.read();
		expect(migrated).toEqual({ ...before, revision: before.revision + 1, tools: {
			...before.tools, next: { enabled: true, enabledAt: before.revision + 1 },
		} });
		expect(await newer.read()).toEqual(migrated);
		expect(await original.read()).toEqual(migrated);
		expect(await retired.read()).toEqual(migrated);
		expect(await original.update(before, { target: "tools", id: "test", enabled: true })).toMatchObject({ ok: false, code: "conflict" });
		await retired.update(migrated, { target: "tools", id: "next", enabled: false });
		expect((await original.read()).tools).toMatchObject({ test: { enabled: false }, next: { enabled: false } });
		expect(JSON.parse(await readFile(join(original.directory, "tool-settings.json"), "utf8"))).toEqual(await newer.read());
		await expect(newer.repair()).rejects.toThrow("Tool settings are unavailable");
	});

	it("orders concurrent hosts and rejects stale edits even on other fields", async () => {
		const first = await create();
		const second = new ToolPolicyStore(inventory, { directory: first.directory });
		const initial = await first.read();
		const results = await Promise.all([
			first.update(initial, { target: "tools", id: "test", enabled: false }),
			second.update(initial, { target: "parents", id: "hopper.rhino", enabled: false }),
		]);
		expect(results.filter(result => result.ok)).toHaveLength(1);
		expect(results.find(result => !result.ok)).toMatchObject({ code: "conflict" });
		expect(await second.withSnapshot(snapshot => snapshot.revision)).toBe(1);
	});
	it("blocks interrupted initialization and missing settings; repair invalidates epochs", async () => {
		const store = await create();
		await writeFile(join(store.directory, "tool-settings.initialized"), "1");
		await expect(store.read()).rejects.toMatchObject({ code: "settings-unavailable" });
		const repaired = await store.repair();
		await rm(join(store.directory, "tool-settings.json"));
		await rm(join(store.directory, "tool-settings.initialized"));
		await expect(store.read()).rejects.toMatchObject({ code: "settings-unavailable" });
		const next = await store.repair();
		expect(next.epoch).not.toBe(repaired.epoch);
		expect(next.parents.firecrawl.enabled).toBe(false);
		expect(await store.update(repaired, { target: "tools", id: "test", enabled: true })).toMatchObject({ ok: false, code: "conflict" });
	});
	it("preserves corrupt and future files until explicit repair", async () => {
		const store = await create();
		for (const text of ["{sentinel-secret", '{"schemaVersion":99}']) {
			await writeFile(join(store.directory, "tool-settings.json"), text);
			await expect(store.read()).rejects.toThrow("Tool settings are unavailable");
			expect(await readFile(join(store.directory, "tool-settings.json"), "utf8")).toBe(text);
		}
	});
	it("recovers a real native cross-process lock after owner death", async () => {
		const store = await create();
		const initial = await store.read();
		const script = `import {openLock,Lock} from '@lickle/lock'; await openLock(process.argv[1],Lock.Exclusive); console.log('locked'); setInterval(()=>{},1000);`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", script, join(store.directory, "tool-settings.lock")], { stdio: ["ignore", "pipe", "pipe"] });
		try {
			await once(child.stdout!, "data");
			let admitted = false;
			const waiting = store.withSnapshot(snapshot => { admitted = true; return snapshot; });
			await new Promise(resolve => setTimeout(resolve, 75));
			expect(admitted).toBe(false);
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
			expect(await waiting).toEqual(initial);
		} finally { child.kill("SIGKILL"); }
	}, 10_000);
});

describe("credential publication", () => {
	it("does not publish a protected write superseded by a disable", async () => {
		const store = await create();
		const initial = await store.read();
		let finish!: () => void;
		let entered!: () => void;
		const started = new Promise<void>(resolve => { entered = resolve; });
		const entries = new Map<string, string>();
		const backend: ProtectedCredentialBackend = {
			read: async reference => entries.get(reference) ?? null,
			write: async (reference, secret) => { entered(); await new Promise<void>(resolve => { finish = resolve; }); entries.set(reference, secret); },
			remove: async reference => { entries.delete(reference); },
		};
		const credentials = new ToolCredentials(store, "firecrawl", backend);
		const save = credentials.save(initial, "sentinel-secret", true);
		await started;
		await store.update(initial, { target: "parents", id: "firecrawl", enabled: false });
		finish();
		expect(await save).toMatchObject({ ok: false, code: "conflict" });
		expect(entries.size).toBe(0);
		expect(await readFile(join(store.directory, "tool-settings.json"), "utf8")).not.toContain("sentinel-secret");
	});
	it("commits removal before failed deletion and sanitizes backend errors", async () => {
		const store = await create();
		const credentials = new ToolCredentials(store, "firecrawl", {
			read: async () => { throw new Error("sentinel-secret"); },
			write: async () => {}, remove: async () => { throw new Error("sentinel-secret"); },
		});
		const saved = await credentials.save(await store.read(), "key", true);
		expect(saved.ok).toBe(true);
		await expect(credentials.read(saved.snapshot)).rejects.not.toThrow("sentinel-secret");
		const removed = await credentials.remove(saved.snapshot);
		expect(removed).toMatchObject({ ok: true, deletionFailed: true, snapshot: { credentials: { firecrawl: { reference: null } } } });
		expect(await credentials.read(await store.read())).toBe(null);
	});
});
