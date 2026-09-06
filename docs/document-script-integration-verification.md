# Document and script integration verification

Both implementations are combined on `feat/document-script-integration`. The separate feature branches are `plan/document-file-management` and `plan/rhino-virtual-scripts`.

The agent can manage `.3dm`, `.gh`, and `.ghx` documents with `rh_document` and `gh_document`, including inspecting units and tolerances with `getSettings`. It can keep Python/C# source in `rh_script`, edit selected lines against a revision, and execute a pinned revision through `rh_run_script`. Existing inline scripts and command macros remain supported. Editing saved source does not replace geometry produced by earlier runs.

## Checks completed on 2026-09-06

| Check | Result |
| --- | --- |
| Full Vitest suite | 464 tests across 52 files passed |
| Hopper.Core | 219 tests passed |
| Standalone Grasshopper test host | 69 tests passed; two native graph tests excluded and run inside Rhino instead |
| Native graph tests | Both passed inside Rhino |
| Cross-language RPC | Authenticated handshake, query, and mutation passed |
| TypeScript and release UI build | Passed, with Vite chunk-size warnings |
| Rhino and Grasshopper production builds | Both `net7.0` and `net7.0-windows` passed |
| Native document lifecycle | `DocumentManagementNativeTests.RunAll` passed |
| Native Python/C# execution | `RhinoScriptNativeTests.RunAll` passed |

Native checks ran on Rhino 8.34.26223.11002 for macOS. The document test covers visible new documents, Unicode paths, `.3dm`/`.gh`/`.ghx` round trips, templates, stale state, tolerance revisions, destination collisions, solver-disabled edits, external saves, and changes made from save callbacks. The script test runs Python and C#, rejects stale document/settings targets before execution, and verifies that one native Undo removes both scripts' geometry. Both tests restore the original document inventory and check that the original Rhino document's modified state is preserved.

The PR review follow-up adds native save callbacks that change notes, model basepoint, render DPI, and earth-anchor data. Each save-before-close reports `DOCUMENT_CHANGED`, keeps the model open, and marks it unsaved. An ordinary save clears the explicitly established AppKit edited state. Background GH path/save/Undo events preserve another definition's agent transaction, and cancel still restores that definition.

New Node regressions cover editable blank lines, continuation after long source lines, execution history longer than revision history, native execution preconditions without an extra Node query, and closing the RPC transport when uncertainty prevents cancellation. The duplicate `expectedSettingsRevision` field was removed; callers use `expectedDocument.settingsRevision`. The review also removed duplicate activation/effect reporting and condensed the completed plans. Workspace-wide replay identity and execution recovery remain intact.

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

The macOS verification above did not install a built plugin or validate Windows. Its restart, host-crash durability, and broader native cases listed in [document management implementation](document-management-implementation.md) were left as release checks; the focused Windows results below are not full release certification.

## Windows loading regression fixes

On Rhino 8.33.26188.13001 for Windows, `DocumentLoadingNativeTests` passed open and template rejection checks for a text-only `.3dm` fixture and a GHX fixture containing one unknown top-level component GUID. Valid `.gh` and `.ghx` lifecycle round trips also passed. Completion establishes that these fixtures did not block on a modal dialog; the tests do not inspect dialogs or cover all corrupt files, nested missing components, or third-party deserializers. Invoke `RejectInvalidRhinoFiles`, `RejectMissingGrasshopperComponents`, and `ValidGrasshopperRoundTrips` with the native runner, which selects `RhinoCode.exe` on Windows (`--rhino-code` overrides it). Rhino must have Grasshopper loaded and an idle command line.

The script-execution regression passes saved revisions through the production backend and validates the actual RPC envelope, ensuring omitted `echo` values remain omitted instead of becoming `undefined` JSON properties. This fix is platform-independent. The Grasshopper archive loader is shared by both platforms; macOS runtime revalidation is still required. The invalid-Rhino-file preflight applies to the Windows replacement path; the existing macOS document-window implementation is unchanged.

Windows validation after these fixes: 17 script-execution tests and the three native entry points pass; TypeScript checking and both Windows production builds pass. Broader suites retain six unrelated Windows path-fixture failures (four host-config expectations and two fake-filesystem profile-scanner tests); these do not exercise the changed paths.

The September 7 review follow-up rebuilt the native test assembly and reran all three entry points successfully on the same Windows Rhino version. The missing-component check now requires its specific error code and fixture GUID; the round-trip harness calls its helper directly and restores the original Grasshopper inventory and active document in `finally`.
