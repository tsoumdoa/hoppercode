import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { evaluatePackagePath } from "./rhino-package-rules.mjs";
import {
	classifyBinary,
	validateBinaryForTarget,
	validateStagedSize,
	verifyRhinoPackage,
} from "./verify-rhino-package.mjs";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

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

function elf(cpu: "arm64" | "x64"): Buffer {
	const buffer = Buffer.alloc(64);
	buffer.set(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
	buffer[4] = 2;
	buffer[5] = 1;
	buffer.writeUInt16LE(cpu === "arm64" ? 0x00b7 : 0x003e, 18);
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
	return stage;
}

describe("Rhino package path rules", () => {
	it("allows the intended runtime trees", () => {
		expect(evaluatePackagePath("manifest.yml", "mac-arm64").allowed).toBe(true);
		expect(evaluatePackagePath("runtime/host/dist/host/index.js", "mac-arm64").allowed).toBe(true);
		expect(evaluatePackagePath("runtime/host/node_modules/zeromq/lib/index.js", "win-x64").allowed).toBe(true);
		expect(evaluatePackagePath("runtimes/win-x64/native/helper.dll", "win-x64").allowed).toBe(true);
	});

	it("keeps Pi's esbuild runtime but rejects the duplicate CLI and dependency tests", () => {
		expect(evaluatePackagePath("runtime/host/node_modules/esbuild/lib/main.js", "mac-arm64").allowed).toBe(true);
		expect(evaluatePackagePath("runtime/host/node_modules/@esbuild/darwin-arm64/bin/esbuild", "mac-arm64").allowed).toBe(true);
		expect(evaluatePackagePath("runtime/host/node_modules/@esbuild/win32-x64/esbuild.exe", "win-x64").allowed).toBe(true);
		expect(evaluatePackagePath("runtime/host/node_modules/esbuild/bin/esbuild", "mac-arm64").allowed).toBe(false);
		expect(evaluatePackagePath("runtime/host/node_modules/@stablelib/base64/base64.test.ts", "mac-arm64").allowed).toBe(false);
		expect(evaluatePackagePath("runtime/host/node_modules/@stablelib/base64/lib/base64.test.js", "mac-arm64").allowed).toBe(false);
	});

	it("rejects installer inputs and first-party development files", () => {
		const paths = [
			"runtime/host/pnpm-lock.yaml",
			"runtime/host/pnpm-workspace.yaml",
			"runtime/host/node_modules/.modules.yaml",
			"runtime/host/node_modules/.pnpm-workspace-state-v1.json",
			"runtime/host/node_modules/.pnpm/lock.yaml",
			"runtime/host/scripts/install-grasshopper-plugin.mjs",
			"runtime/host/dist/host/index.js.map",
			"runtime/host/dist/host/server.test.js",
			"runtime/node/darwin-arm64/bin/node",
			"runtime/host/node_modules/.bin/pi",
			"runtime/host/node_modules/typescript/lib/typescript.js",
		];
		for (const path of paths) expect(evaluatePackagePath(path, "mac-arm64").allowed, path).toBe(false);
	});

	it("rejects paths outside the allowlist and target-mismatched managed runtime folders", () => {
		expect(evaluatePackagePath("notes.txt", "mac-arm64").allowed).toBe(false);
		expect(evaluatePackagePath("Unexpected.Plugin.dll", "mac-arm64").allowed).toBe(false);
		expect(evaluatePackagePath("extra.config", "mac-arm64").allowed).toBe(false);
		expect(evaluatePackagePath("runtimes/win-x64/native/helper.dll", "mac-arm64").allowed).toBe(false);
	});

	it("rejects the retired standalone Rhino host assembly", () => {
		const result = evaluatePackagePath("Hopper.Rhino.Host.dll", "mac-arm64");
		expect(result.allowed).toBe(false);
		expect(result.rule.id).toBe("retired-host-assembly");
	});
});

describe("native binary classification", () => {
	it("recognizes thin and fat Mach-O architectures", () => {
		expect(classifyBinary(macho("arm64"), "addon.node")).toMatchObject({
			format: "mach-o",
			os: "darwin",
			architectures: ["arm64"],
		});
		const universal = classifyBinary(fatMacho(["arm64", "x64"]), "addon.node");
		expect(universal?.architectures).toEqual(["arm64", "x64"]);
		expect(validateBinaryForTarget(universal, "mac-arm64")).toContain("x64");
	});

	it("recognizes ELF and rejects it for both supported targets", () => {
		const binary = classifyBinary(elf("x64"), "addon.node");
		expect(binary).toMatchObject({ format: "elf", os: "linux", architectures: ["x64"] });
		expect(validateBinaryForTarget(binary, "win-x64")).toContain("linux");
	});

	it("recognizes native PE machine types", () => {
		const binary = classifyBinary(pe("x64"), "addon.node");
		expect(binary).toMatchObject({ format: "pe", os: "win32", architectures: ["x64"], managed: false });
		expect(validateBinaryForTarget(binary, "win-x64")).toBeNull();
		expect(validateBinaryForTarget(binary, "mac-arm64")).toContain("win32");
	});

	it("reads the PE CLI directory and treats a mapped CLI header as managed", () => {
		const binary = classifyBinary(pe("x86", true), "Hopper.Core.dll");
		expect(binary).toMatchObject({ format: "pe", os: "managed", architectures: ["any"], managed: true });
		expect(validateBinaryForTarget(binary, "mac-arm64")).toBeNull();
		expect(validateBinaryForTarget(binary, "win-x64")).toBeNull();
	});

	it("does not trust a PE CLI directory whose RVA is not mapped", () => {
		const buffer = pe("x86", true);
		buffer.writeUInt32LE(0x9000, 0x80 + 24 + 112 + 14 * 8);
		const binary = classifyBinary(buffer, "suspicious.dll");
		expect(binary?.managed).toBe(false);
		expect(validateBinaryForTarget(binary, "win-x64")).toContain("x86");
	});

	it("rejects a native extension with an unknown header", () => {
		const binary = classifyBinary(Buffer.from("not a native binary"), "addon.node");
		expect(binary?.format).toBe("unknown");
		expect(validateBinaryForTarget(binary, "mac-arm64")).toContain("unrecognized");
	});
});

describe("Rhino package verifier", () => {
	it.each(["mac-arm64", "win-x64"] as const)("requires the target esbuild executable for %s", async (target) => {
		const stage = await minimalStage(target);
		await rm(join(stage, "runtime/host/node_modules/@esbuild"), { recursive: true });
		await expect(verifyRhinoPackage({ target, stage, quiet: true })).rejects.toThrow("target-native esbuild executable is missing");
	});

	it("rejects a build-host esbuild binary left in a Windows package", async () => {
		const stage = await minimalStage("win-x64");
		await fixtureFile(stage, "runtime/host/node_modules/@esbuild/darwin-arm64/bin/esbuild", macho("arm64"));
		await expect(verifyRhinoPackage({ target: "win-x64", stage, quiet: true })).rejects.toThrow("mach-o targets darwin, expected win32");
	});

	it("enforces the documented per-target size ceilings", () => {
		expect(validateStagedSize("mac-arm64", 128 * 1024 * 1024)).toBeNull();
		expect(validateStagedSize("mac-arm64", 128 * 1024 * 1024 + 1)).toContain("above");
		expect(validateStagedSize("win-x64", 128 * 1024 * 1024)).toBeNull();
		expect(validateStagedSize("win-x64", 128 * 1024 * 1024 + 1)).toContain("above");
	});

	it("writes a stable sorted manifest with sizes and SHA-256 hashes", async () => {
		const stage = await minimalStage("mac-arm64");
		await fixtureFile(stage, "runtime/host/dist/a.js", "a\n");
		const result = await verifyRhinoPackage({ target: "mac-arm64", stage, quiet: true });
		const paths = result.manifest.files.map((file: { path: string }) => file.path);
		expect(paths).toEqual([...paths].sort((left, right) => left.localeCompare(right)));
		const entry = result.manifest.files.find((file: { path: string }) => file.path === "runtime/host/dist/a.js");
		expect(entry).toEqual({
			path: "runtime/host/dist/a.js",
			size: 2,
			sha256: createHash("sha256").update("a\n").digest("hex"),
		});
		expect(JSON.parse(await readFile(result.manifestPath, "utf8"))).toEqual(result.manifest);
		const repeated = await verifyRhinoPackage({ target: "mac-arm64", stage, quiet: true });
		expect(repeated.manifest).toEqual(result.manifest);
	});

	it("accepts matching Windows native files and managed assemblies", async () => {
		const stage = await minimalStage("win-x64");
		await fixtureFile(stage, "Hopper.Core.dll", pe("x86", true));
		await expect(verifyRhinoPackage({ target: "win-x64", stage, quiet: true })).resolves.toBeDefined();
	});

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

	it("reports all denied paths in one failure", async () => {
		const stage = await minimalStage("mac-arm64");
		await fixtureFile(stage, "runtime/host/pnpm-lock.yaml", "lockfileVersion: 9\n");
		await fixtureFile(stage, "runtime/host/dist/host/index.js.map", "{}\n");
		await expect(verifyRhinoPackage({ target: "mac-arm64", stage, quiet: true })).rejects.toThrow(
			/pnpm-lock\.yaml[\s\S]*index\.js\.map|index\.js\.map[\s\S]*pnpm-lock\.yaml/,
		);
	});

	it("requires the exact three-project runtime artifacts", async () => {
		const stage = await minimalStage("mac-arm64");
		await rm(join(stage, "runtime", "host", "node_modules", "zeromq", "build", "manifest.json"));
		await rm(join(stage, "Hopper.Core.dll"));
		await rm(join(stage, "Hopper.Rhino.rhp"));
		await expect(verifyRhinoPackage({ target: "mac-arm64", stage, quiet: true })).rejects.toThrow(
			/Hopper\.Core\.dll[\s\S]*Hopper\.Rhino\.rhp[\s\S]*manifest\.json/,
		);
	});

	it("rejects a retired standalone Rhino host assembly", async () => {
		const stage = await minimalStage("mac-arm64");
		await fixtureFile(stage, "Hopper.Rhino.Host.dll", pe("x86", true));
		await expect(verifyRhinoPackage({ target: "mac-arm64", stage, quiet: true })).rejects.toThrow(
			/Hopper\.Rhino\.Host\.dll: retired-host-assembly/,
		);
	});

	it("rejects symbolic links", async () => {
		const stage = await minimalStage("mac-arm64");
		await symlink(join(stage, "manifest.yml"), join(stage, "runtime", "host", "dist", "linked.js"));
		await expect(verifyRhinoPackage({ target: "mac-arm64", stage, quiet: true })).rejects.toThrow("symbolic links");
	});

	it("discovers Yak artifacts and excludes them from the payload manifest", async () => {
		const stage = await minimalStage("mac-arm64");
		await fixtureFile(stage, "hopper-pi-0.1.90-rh8_0-mac.yak", Buffer.alloc(37));
		const result = await verifyRhinoPackage({ target: "mac-arm64", stage, quiet: true });
		expect(result.yakFiles).toEqual([{ path: "hopper-pi-0.1.90-rh8_0-mac.yak", size: 37 }]);
		expect(result.manifest.files.some((file: { path: string }) => file.path.endsWith(".yak"))).toBe(false);
	});

	it("runs through the checked-in package script CLI", async () => {
		const stage = await minimalStage("mac-arm64");
		const script = join(process.cwd(), "scripts", "verify-rhino-package.mjs");
		const { stdout } = await execFileAsync(process.execPath, [script, "--target", "mac-arm64", stage]);
		expect(stdout).toContain("Verified 10 staged files for mac-arm64");
		expect(JSON.parse(await readFile(join(stage, "rhino-package-manifest.json"), "utf8")).target)
			.toBe("mac-arm64");
	});
});
