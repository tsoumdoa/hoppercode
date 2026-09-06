#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, access, mkdir, readdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, basename } from "node:path";

const usage = `Run selected parameterless test methods inside an explicitly selected running Rhino.

Usage:
  node scripts/run-native-tests.mjs --rhino <instance-id> --assembly <test.dll>
    --type <full-type-name> --method <name> [--method <name> ...]
    [--rhino-code <RhinoCode.dll>] [--timeout-ms <milliseconds>]

Build the test assembly first. Methods must create/dispose their own temporary
documents and preserve user documents. This runner loads Hopper/test assemblies
in an isolated context; it does not install or replace the active Hopper plugin.
It does not retry after a timeout, since native execution may still be running.
`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.length === 0) {
	console.log(usage);
	process.exit(args.includes("--help") ? 0 : 1);
}
const values = new Map();
const methods = [];
for (let i = 0; i < args.length; i += 2) {
	const option = args[i];
	const value = args[i + 1];
	if (!["--rhino", "--assembly", "--type", "--method", "--rhino-code", "--timeout-ms"].includes(option)
		|| !value || value.startsWith("--")) throw new Error(`Invalid argument ${option}.\n${usage}`);
	if (option === "--method") methods.push(value);
	else {
		if (values.has(option)) throw new Error(`Repeated argument ${option}`);
		values.set(option, value);
	}
}
for (const required of ["--rhino", "--assembly", "--type"]) {
	if (!values.has(required)) throw new Error(`Missing ${required}.\n${usage}`);
}
if (methods.length === 0) throw new Error("At least one --method is required.");
const inputAssembly = resolve(values.get("--assembly"));
const rhinoCode = values.get("--rhino-code")
	?? "/Applications/Rhino 8.app/Contents/Frameworks/RhCore.framework/Versions/A/Resources/RhinoCode.dll";
if (!isAbsolute(rhinoCode)) throw new Error("--rhino-code must be an absolute path.");
const timeout = Number(values.get("--timeout-ms") ?? 120_000);
if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000) {
	throw new Error("--timeout-ms must be an integer between 1 and 600000.");
}
await Promise.all([access(inputAssembly), access(rhinoCode)]);
const runDir = await mkdtemp(join(tmpdir(), "hopper-native-tests-"));
// Rhino can retain mapped assemblies after an ALC unload. A unique snapshot path
// prevents a later build from silently reusing an older native test image.
const snapshotDirectory = join(runDir, "assemblies");
await mkdir(snapshotDirectory);
await Promise.all((await readdir(dirname(inputAssembly), { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => copyFile(join(dirname(inputAssembly), entry.name), join(snapshotDirectory, entry.name))));
const assembly = join(snapshotDirectory, basename(inputAssembly));
const resultPath = join(runDir, "result.txt");
const sourcePath = join(runDir, "run.cs");
// C# verbatim literals keep paths and method names as data, including quotes.
const literal = (value) => `@"${value.replaceAll('"', '""')}"`;
const source = `// #! csharp
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading.Tasks;

// Run after RhinoCode releases its document-bound script context, just as the
// production dispatcher runs operations from a native UI callback.
EventHandler runTests = null;
runTests = (sender, args) =>
{
Rhino.RhinoApp.Idle -= runTests;
var output = new System.Collections.Generic.List<string>();
var directory = ${literal(dirname(assembly))};
var context = new HopperTestContext(directory);
try
{
    var assembly = context.LoadFromAssemblyPath(${literal(assembly)});
    var type = assembly.GetType(${literal(values.get("--type"))}, true);
    object instance = null;
    foreach (var name in new[] { ${methods.map(literal).join(", ")} })
    {
        try
        {
            var method = type.GetMethod(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static);
            if (method == null || method.GetParameters().Length != 0)
                throw new InvalidOperationException("Expected a public parameterless method: " + name);
            if (typeof(Task).IsAssignableFrom(method.ReturnType) || method.ReturnType.FullName.StartsWith("System.Threading.Tasks.ValueTask"))
                throw new InvalidOperationException("Native UI test methods must finish synchronously; asynchronous methods are unsupported.");
            if (!method.IsStatic && instance == null) instance = Activator.CreateInstance(type);
            var result = method.Invoke(method.IsStatic ? null : instance, null);
            if (result is Task) throw new InvalidOperationException("Native UI test methods must finish synchronously; asynchronous methods are unsupported.");
            output.Add("PASS " + name);
        }
        catch (Exception error)
        {
            output.Add("FAIL " + name + " " + (error.InnerException ?? error).ToString());
            break;
        }
    }
    if (instance is IDisposable disposable) disposable.Dispose();
}
catch (Exception error) { output.Add("HARNESS_ERROR " + error.ToString()); }
finally
{
    File.WriteAllLines(${literal(resultPath)}, output);
    context.Unload();
}
};
Rhino.RhinoApp.Idle += runTests;

public class HopperTestContext : AssemblyLoadContext
{
    private readonly string directory;
    public HopperTestContext(string directory) : base("HopperNativeTests_" + Guid.NewGuid().ToString("N"), true) { this.directory = directory; }
    protected override Assembly Load(AssemblyName name)
    {
        if (name.Name.StartsWith("Hopper") || name.Name.StartsWith("xunit"))
        {
            foreach (var ext in new[] { ".dll", ".rhp", ".gha" })
            {
                var local = Path.Combine(directory, name.Name + ext);
                if (File.Exists(local)) return LoadFromAssemblyPath(local);
            }
        }
        var shared = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => a.GetName().Name == name.Name && AssemblyLoadContext.GetLoadContext(a) == AssemblyLoadContext.Default);
        if (shared != null) return shared;
        var path = Path.Combine(directory, name.Name + ".dll");
        return File.Exists(path) ? LoadFromAssemblyPath(path) : null;
    }
}

`;
await writeFile(sourcePath, source);
console.log(`Native test artifacts: ${runDir}`);
const deadline = Date.now() + timeout;
const outcome = await new Promise((accept, reject) => {
	const child = spawn("dotnet", [rhinoCode, "--rhino", values.get("--rhino"), "script", sourcePath], {
		stdio: ["ignore", "inherit", "inherit"], timeout,
	});
	child.once("error", reject);
	child.once("exit", (code, signal) => accept({ code, signal }));
});
if (outcome.signal) {
	throw new Error(`RhinoCode ended with ${outcome.signal}. Native outcome is unknown; do not retry automatically. Inspect ${runDir}.`);
}
let result;
// The RhinoCode CLI can acknowledge a queued script before its execution finishes.
// Wait for the native result instead of interpreting CLI exit zero as completion.
while (Date.now() <= deadline && outcome.code === 0) {
	try { result = await readFile(resultPath, "utf8"); break; }
	catch (error) {
		if (error.code !== "ENOENT") throw error;
		await new Promise((done) => setTimeout(done, Math.min(250, Math.max(1, deadline - Date.now()))));
	}
}
if (result === undefined) {
	throw new Error(`No native result was produced (CLI exit ${outcome.code}). Inspect Rhino script errors and ${runDir}; do not assume native work was canceled.`);
}
console.log(result.trimEnd());
const passed = result.split(/\r?\n/).filter((line) => line.startsWith("PASS ")).length;
if (outcome.code !== 0 || /^(FAIL|HARNESS_ERROR) /m.test(result) || passed !== methods.length) process.exitCode = 1;
