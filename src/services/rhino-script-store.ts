import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fail } from "./source-line-patches.js";
export const SCRIPT_PROCESS_ID = randomUUID();
const DEFAULT_QUOTA = 64 * 1024 * 1024;
export const RUN_RESERVE_BYTES = 128_000;
export class RhinoScriptStore {
	readonly directory: string;
	readonly quotaBytes: number;
	private id?: string;
	constructor(workspaceDirectory: string, quotaBytes = DEFAULT_QUOTA) {
		this.directory = join(
			resolve(workspaceDirectory),
			".hopper",
			"rhino-scripts",
		);
		if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1)
			fail("INVALID_INPUT", "Workspace quota must be a positive integer");
		this.quotaBytes = quotaBytes;
	}
	get workspaceId(): string {
		if (this.id) return this.id;
		if (existsSync(join(this.directory, "manifest.json")))
			return (this.id = this.readManifest());
		return this.transaction(() => {
			if (existsSync(join(this.directory, "manifest.json")))
				return (this.id = this.readManifest());
			const id = randomUUID().replaceAll("-", "");
			this.write("manifest", { schemaVersion: 1, workspaceId: id });
			return (this.id = id);
		});
	}
	private readManifest(): string {
		const value = this.read<{ schemaVersion: number; workspaceId: string }>(
			"manifest",
		);
		if (value.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(value.workspaceId))
			fail("WORKSPACE_CORRUPT", "Invalid manifest; retained for inspection", {
				directory: this.directory,
			});
		return value.workspaceId;
	}
	transaction<T>(fn: () => T): T {
		mkdirSync(this.directory, { recursive: true });
		const lockPath = join(this.directory, "writer.lock");
		const claim = randomUUID();
		const recoveryPath = join(this.directory, "recovery.lock");
		let fd: number;
		try {
			fd = openSync(lockPath, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let owner: { pid: number; hostname: string; claim: string };
			try {
				owner = JSON.parse(readFileSync(lockPath, "utf8"));
			} catch {
				return fail(
					"WORKSPACE_BUSY",
					"Writer lock is unreadable; inspect it before manual recovery",
					{ lockPath },
				);
			}
			if (
				owner.hostname === hostname() &&
				Number.isSafeInteger(owner.pid) &&
				owner.pid > 0 &&
				provenDead(owner.pid)
			) {
				// Only one recovery may unlink a dead writer. Ordinary writers yield while
				// this guard exists, closing the ABA race between stale inspection and unlink.
				let recovery: number;
				try {
					recovery = openSync(recoveryPath, "wx", 0o600);
				} catch {
					return fail(
						"WORKSPACE_BUSY",
						"Lock recovery is active or interrupted; inspect recovery.lock before manual recovery",
					);
				}
				try {
					writeFileSync(recovery, JSON.stringify({ pid: process.pid, claim }));
					fsyncSync(recovery);
					const current = JSON.parse(readFileSync(lockPath, "utf8"));
					if (current.claim !== owner.claim || !provenDead(current.pid))
						return fail(
							"WORKSPACE_BUSY",
							"Workspace writer changed during recovery",
						);
					unlinkSync(lockPath);
					try {
						fd = openSync(lockPath, "wx", 0o600);
					} catch {
						return fail("WORKSPACE_BUSY", "Another workspace writer is active");
					}
				} finally {
					closeSync(recovery);
					unlinkSync(recoveryPath);
				}
			} else
				return fail("WORKSPACE_BUSY", "Another workspace writer is active", {
					owner,
				});
		}
		try {
			writeFileSync(
				fd,
				JSON.stringify({
					pid: process.pid,
					hostname: hostname(),
					processId: SCRIPT_PROCESS_ID,
					claim,
				}),
			);
			fsyncSync(fd);
			if (existsSync(recoveryPath))
				return fail("WORKSPACE_BUSY", "Workspace lock recovery is active");
			return fn();
		} finally {
			closeSync(fd);
			try {
				if (JSON.parse(readFileSync(lockPath, "utf8")).claim === claim)
					unlinkSync(lockPath);
			} catch {
				/* Never remove a lock with different ownership. */
			}
		}
	}
	read<T>(id: string): T {
		const file = this.file(id);
		try {
			return JSON.parse(readFileSync(file, "utf8")) as T;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return fail("NOT_FOUND", `Record ${id} does not exist`);
			return fail("WORKSPACE_CORRUPT", `Cannot read ${id}; record retained`, {
				file,
			});
		}
	}
	exists(id: string): boolean {
		return existsSync(this.file(id));
	}
	list(prefix: string): string[] {
		if (!existsSync(this.directory)) return [];
		return readdirSync(this.directory)
			.filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
			.map((n) => n.slice(0, -5));
	}
	usage(): number {
		if (!existsSync(this.directory)) return 0;
		// Interrupted atomic writes remain inspectable and still consume quota.
		return readdirSync(this.directory)
			.filter((name) => name.endsWith(".json") || name.endsWith(".tmp"))
			.reduce(
				(sum, name) => sum + statSync(join(this.directory, name)).size,
				0,
			);
	}
	assertCapacity(
		writes: Array<{ id: string; value: unknown }>,
		reserveBytes = 0,
	): void {
		let proposed = this.usage() + reserveBytes;
		for (const { id, value } of writes)
			proposed +=
				Buffer.byteLength(JSON.stringify(value)) -
				(this.exists(id) ? statSync(this.file(id)).size : 0);
		// Each admitted batch reserves bounded completion growth for every run.
		for (const id of this.list("batch_")) {
			const batch = this.read<{ runs: Array<{ runId: string }> }>(id);
			for (const run of batch.runs) {
				const exists = this.exists(run.runId);
				const state = exists
					? this.read<{ state: string }>(run.runId).state
					: "prepared";
				if (!["completed", "failed", "notStarted", "notRun"].includes(state))
					proposed +=
						RUN_RESERVE_BYTES +
						(exists ? 0 : Buffer.byteLength(JSON.stringify(run)));
			}
		}
		if (proposed > this.quotaBytes)
			fail(
				"WORKSPACE_LIMIT_REACHED",
				"Increase HOPPER_SCRIPT_WORKSPACE_QUOTA_BYTES to retain more history",
				{
					storagePath: this.directory,
					usedBytes: this.usage(),
					quotaBytes: this.quotaBytes,
					requiredBytes: proposed,
				},
			);
	}
	write(id: string, value: unknown): void {
		const target = this.file(id),
			temp = `${target}.${randomUUID()}.tmp`;
		const fd = openSync(temp, "wx", 0o600);
		try {
			writeFileSync(fd, JSON.stringify(value));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		try {
			renameSync(temp, target);
		} finally {
			if (existsSync(temp)) unlinkSync(temp);
		}
		// Directory fsync is supported on Unix. Windows rejects opening directories.
		if (process.platform !== "win32") {
			const dir = openSync(this.directory, "r");
			try {
				fsyncSync(dir);
			} finally {
				closeSync(dir);
			}
		}
	}
	private file(id: string): string {
		if (!/^[a-zA-Z0-9_-]+$/.test(id))
			fail("INVALID_ID", "Record IDs cannot contain paths");
		return join(this.directory, `${id}.json`);
	}
}
export function provenDead(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}
