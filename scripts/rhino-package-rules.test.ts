import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyRhinoPackage } from "./verify-rhino-package.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hopper-package-rules-"));
	temporaryDirectories.push(path);
	return path;
}

async function fixtureFile(root: string, path: string, contents: string | Buffer): Promise<void> {
	const absolutePath = join(root, ...path.split("/"));
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, contents);
}

function macho(cpu: "arm64" | "x64"): Buffer {
	const buffer = Buffer.alloc(32);
	buffer.set(Buffer.from("cffaedfe", "hex"));
	buffer.writeUInt32LE(cpu === "arm64" ? 0x0100000c : 0x01000007, 4);
	return buffer;
}

function fatMacho(cpus: Array<"arm64" | "x64">): Buffer {
	const buffer = Buffer.alloc(8 + cpus.length * 20);
	buffer.set(Buffer.from("cafebabe", "hex"));
	buffer.writeUInt32BE(cpus.length, 4);
	for (const [index, cpu] of cpus.entries()) {
		buffer.writeUInt32BE(cpu === "arm64" ? 0x0100000c : 0x01000007, 8 + index * 20);
	}
	return buffer;
}

function pe(cpu: "x86" | "x64" | "arm64", managed = false): Buffer {
	const buffer = Buffer.alloc(0x400);
	const peOffset = 0x80;
	const optionalOffset = peOffset + 24;
	const optionalSize = 0xf0;
	buffer.write("MZ", 0, "ascii");
	buffer.writeUInt32LE(peOffset, 0x3c);
	buffer.write("PE\0\0", peOffset, "ascii");
	buffer.writeUInt16LE(cpu === "x86" ? 0x014c : cpu === "x64" ? 0x8664 : 0xaa64, peOffset + 4);
	buffer.writeUInt16LE(1, peOffset + 6);
	buffer.writeUInt16LE(optionalSize, peOffset + 20);
	buffer.writeUInt16LE(0x20b, optionalOffset);
	buffer.writeUInt32LE(0x200, optionalOffset + 60);
	buffer.writeUInt32LE(16, optionalOffset + 108);
	const sectionOffset = optionalOffset + optionalSize;
	buffer.write(".text\0\0\0", sectionOffset, "ascii");
	buffer.writeUInt32LE(0x200, sectionOffset + 8);
	buffer.writeUInt32LE(0x2000, sectionOffset + 12);
	buffer.writeUInt32LE(0x200, sectionOffset + 16);
	buffer.writeUInt32LE(0x200, sectionOffset + 20);
	if (managed) {
		const cliDirectoryOffset = optionalOffset + 112 + 14 * 8;
		buffer.writeUInt32LE(0x2000, cliDirectoryOffset);
		buffer.writeUInt32LE(72, cliDirectoryOffset + 4);
		buffer.writeUInt32LE(72, 0x200);
	}
	return buffer;
}

async function minimalStage(target: "mac-arm64" | "win-x64"): Promise<string> {
	const stage = await temporaryDirectory();
	await fixtureFile(stage, "manifest.yml", "name: hopper-pi\n");
	await fixtureFile(stage, "Hopper.Core.dll", pe("x86", true));
	await fixtureFile(stage, "Hopper.Grasshopper.gha", pe("x86", true));
	await fixtureFile(stage, "Hopper.Rhino.rhp", pe("x86", true));
	await fixtureFile(stage, "runtime/hopper-runtime.json", "{}\n");
	await fixtureFile(stage, "runtime/host/package.json", "{\"type\":\"module\"}\n");
	await fixtureFile(stage, "runtime/host/dist/host/index.js", "export {};\n");
	await fixtureFile(stage, "runtime/host/node_modules/zeromq/build/manifest.json", "{}\n");
	const nativePath = target === "mac-arm64"
		? "runtime/host/node_modules/zeromq/build/darwin/arm64/node/libc-115-Release/addon.node"
		: "runtime/host/node_modules/zeromq/build/win32/x64/node/msvc-115-Release/addon.node";
	await fixtureFile(stage, nativePath, target === "mac-arm64" ? macho("arm64") : pe("x64"));
	await fixtureFile(stage, target === "mac-arm64"
		? "runtime/host/node_modules/@esbuild/darwin-arm64/bin/esbuild"
		: "runtime/host/node_modules/@esbuild/win32-x64/esbuild.exe", target === "mac-arm64" ? macho("arm64") : pe("x64"));
	const suffix = target === "mac-arm64" ? "darwin-arm64" : "win32-x64-msvc";
	for (const dependency of [`@lickle/lock-${suffix}`, `@napi-rs/keyring-${suffix}`]) {
		await fixtureFile(stage, `runtime/host/node_modules/${dependency}/addon.node`, target === "mac-arm64" ? macho("arm64") : pe("x64"));
	}
	return stage;
}

describe("Rhino package verifier", () => {

	it("rejects corrupt required plug-in assemblies", async () => {
		for (const path of ["Hopper.Grasshopper.gha", "Hopper.Rhino.rhp"]) {
			const stage = await minimalStage("mac-arm64");
			await fixtureFile(stage, path, "not an assembly\n");
			await expect(verifyRhinoPackage({ target: "mac-arm64", stage, quiet: true }))
				.rejects.toThrow(`${path}: required plug-in must be a managed PE assembly`);
		}
	});

	it("rejects wrong-OS, wrong-CPU, and mixed universal binaries", async () => {
		for (const binary of [pe("x64"), macho("x64"), fatMacho(["arm64", "x64"])]) {
			const stage = await minimalStage("mac-arm64");
			await fixtureFile(stage, "runtime/host/node_modules/bad/addon.node", binary);
			await expect(verifyRhinoPackage({ target: "mac-arm64", stage, quiet: true })).rejects.toThrow(/addon\.node/);
		}
	});

	it("rejects symbolic links", async () => {
		const stage = await minimalStage("mac-arm64");
		await symlink(join(stage, "manifest.yml"), join(stage, "runtime", "host", "dist", "linked.js"));
		await expect(verifyRhinoPackage({ target: "mac-arm64", stage, quiet: true })).rejects.toThrow("symbolic links");
	});
});
