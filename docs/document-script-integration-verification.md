# Document and script integration verification

Both implementations are combined on `feat/document-script-integration`. The separate feature branches are `plan/document-file-management` and `plan/rhino-virtual-scripts`.

The agent can manage `.3dm`, `.gh`, and `.ghx` documents with `rh_document` and `gh_document`, including inspecting units and tolerances with `getSettings`. It can keep Python/C# source in `rh_script`, edit selected lines against a revision, and execute a pinned revision through `rh_run_script`. Existing inline scripts and command macros remain supported. Editing saved source does not replace geometry produced by earlier runs.

## Checks completed on 2026-09-06

| Check | Result |
| --- | --- |
| Full Vitest suite | 456 tests across 52 files passed |
| Hopper.Core | 218 tests passed |
| Standalone Grasshopper test host | 69 tests passed; two native graph tests excluded and run inside Rhino instead |
| Native graph tests | Both passed inside Rhino |
| Cross-language RPC | Authenticated handshake, query, and mutation passed |
| TypeScript and release UI build | Passed, with Vite chunk-size warnings |
| Rhino and Grasshopper production builds | Both `net7.0` and `net7.0-windows` passed |
| Native document lifecycle | `DocumentManagementNativeTests.RunAll` passed |
| Native Python/C# execution | `RhinoScriptNativeTests.RunAll` passed |

Native checks ran on Rhino 8.34.26223.11002 for macOS. The document test covers visible new documents, Unicode paths, `.3dm`/`.gh`/`.ghx` round trips, templates, stale state, tolerance revisions, destination collisions, solver-disabled edits, external saves, and changes made from save callbacks. The script test runs Python and C#, rejects stale document/settings targets before execution, and verifies that one native Undo removes both scripts' geometry. Both tests restore the original document inventory and check that the original Rhino document's modified state is preserved.

Storage, pinned asset execution, replay, concurrency, restart recovery, and uncertain-result handling have automated Node coverage. The native script test invokes the shared executor directly; it does not constitute an end-to-end UI test of asset creation through execution.

## Running the native checks

Build `grasshopper-plugin.Tests/grasshopper-plugin.Tests.csproj`, then obtain an explicit running instance ID with RhinoCode's `list --json` command. Run each entry point with the helper, for example:

```sh
node scripts/run-native-tests.mjs \
  --rhino <instance-id> \
  --assembly <absolute-path>/grasshopper-plugin.Tests/bin/Debug/net8.0/rhino-zmq-poc.Tests.dll \
  --type grasshopper_plugin.Tests.RhinoScriptNativeTests \
  --method RunAll \
  --timeout-ms 60000
```

Use `grasshopper_plugin.Tests.DocumentManagementNativeTests` for document checks. Use `grasshopper_plugin.Tests.ApplyGraphContractTests` with methods `Invalid_port_after_creation_rolls_back_to_byte_equal_snapshot` and `Multi_wire_graph_runs_one_solution` for the two graph checks.

The helper copies assemblies to a unique temporary directory and loads them in an isolated context. A one-shot Rhino Idle callback runs the tests after RhinoCode releases its own script context. A CLI acknowledgement alone is not a pass. The helper waits for the native result file and retains diagnostic artifacts. A timeout must not trigger an automatic retry because execution may still be running.

No built plugin was installed by this verification workflow. Windows runtime behavior, actual `HopperCodeRestart`, host-crash durability on each platform, and the broader native cases listed in [document management implementation](document-management-implementation.md) remain release checks.
