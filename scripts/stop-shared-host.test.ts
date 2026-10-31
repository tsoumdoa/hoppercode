import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { stopSharedHost } from "./stop-shared-host.mjs";

const directories: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill();
			await exited;
		}
	}
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory() {
	const path = await mkdtemp(join(tmpdir(), "hopper-stop-host-"));
	directories.push(path);
	return path;
}

async function host(exitNaturally = false) {
	const path = await directory();
	const child = spawn(process.execPath, ["--input-type=module", "-e", `
		import { createServer } from 'node:http';
		const health = { pid: process.pid, hostEpoch: 'test-epoch', processStartIdentity: 'test-start', ready: true };
		const server = createServer((req, res) => res.end(JSON.stringify(health)));
		server.listen(0, '127.0.0.1', () => process.send({ ...health, endpointPort: server.address().port }));
		process.once('SIGTERM', () => setTimeout(() => server.close(() => process.exit(0)), 100));
		if (${exitNaturally}) setTimeout(() => server.close(() => process.exit(0)), 500);
	`], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
	children.push(child);
	const [discovery] = await once(child, "message");
	await writeFile(join(path, "discovery.json"), JSON.stringify(discovery));
	return { path, child, discovery };
}

it("waits for the verified host's graceful shutdown before allowing package replacement", async () => {
	const { path, child } = await host(process.platform === "win32");
	const exited = once(child, "exit");
	await stopSharedHost(path);
	await exited;
	expect(child.exitCode).toBe(0);
	expect(child.signalCode).toBeNull();
	// A stopped host leaves discovery behind; reinstalling again must still work.
	await stopSharedHost(path);
});

it("does not signal a process when discovery belongs to another host lifetime", async () => {
	const { path, child, discovery } = await host();
	await writeFile(join(path, "discovery.json"), JSON.stringify({ ...discovery, hostEpoch: "old-epoch" }));
	await expect(stopSharedHost(path)).rejects.toThrow("Could not verify");
	expect(child.exitCode).toBeNull();
	expect(child.signalCode).toBeNull();
});
