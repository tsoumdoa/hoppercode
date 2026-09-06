# Editable Rhino script workspace plan

Status: implementation plan only. No runtime changes made.

Date: 2026-09-06. Base: `26d0a2c`, from `t3code/self-host-pi-rhino`.

Branch: `plan/rhino-virtual-scripts`.
Worktree: `/Users/tomohirosugeta/repo/hoppercode-virtual-scripts`.

## Outcome and feasibility

Yes, Hopper can give the agent fine-grained Rhino script editing by keeping named Python/C# source assets in a persistent workspace. The agent creates a script once, reads numbered lines, patches a few lines against a revision, inspects the diff, and explicitly runs the chosen revision in Rhino.

The code remains available after the tool call and across resumed sessions. The model does not need to reproduce a long script to change one expression. This does not require a live Rhino Script Editor document or unrestricted filesystem tools.

Editing source alone must never execute code. Running a revised script has the same geometry effects as executing that source today. It does not automatically remove geometry produced by an earlier run or provide Grasshopper's parametric recomputation.

## Existing code and constraints

- [rh_run_script](../src/tools/rh-run-script.ts) accepts full source, language/macro mode, and echo. It has no script identity or read/edit actions. Preserve existing calls.
- [RhinoCodeRunner](../dotnet/Hopper.Rhino/Operations/RhinoCodeRunner.cs) compiles/runs supplied source. The virtual workspace should feed this existing execution path rather than add another Python/C# engine.
- [GH script tool](../src/tools/edit-tools/gh-edit-script.ts) already offers numbered insert/replace/delete patches. Its C# scopes describe `Script_Instance` and `RunScript`, which do not fit ordinary Rhino script-editor bodies.
- [C# patch implementation](../src/services/csharp-script-patcher.ts) contains reusable full-source line handling; [scoped patching](../src/lib/scoped-patcher.ts) wraps it. Extract only generic mechanics and preserve GH behavior with regression tests.
- [Embedded runtime](../src/host/pi-runtime.ts) disables built-in editing/writing tools. Provide narrowly scoped script tools instead of changing that policy.
- [Host paths](../src/host/config.ts) already separate application data, workspaces, and sessions. Inject a workspace service through the extension factory/runtime integration, with a supported fallback for `pi -e .`.
- [Tool registration](../src/index.ts) currently backend-guards every catalog tool. Local script creation/inspection/editing must work while Rhino is offline, so registration must honor per-tool requirements.
- [Runtime RPC](../src/infra/runtime-rpc.ts) already handles retained mutations, unknown outcomes, and per-turn Rhino Undo. Reuse these for execution.

## Tool design

Add one discoverable local tool, `rh_script`, for source assets. Extend `rh_run_script` to execute an asset by ID and revision. Keeping execution in the existing tool makes its Rhino side effects explicit and avoids duplicating run handling.

| `rh_script` action | Inputs | Behavior |
| --- | --- | --- |
| `create` | `name`, `language`, `source` | Persist a new asset and revision 1. Return ID, revision, hash, and line count. |
| `list` | Optional name filter and pagination | List this workspace's scripts and current revisions without dumping source. |
| `get` | `scriptId`, optional `revision`, `startLine`, `endLine` | Return exact source range with line numbers and revision metadata. |
| `patch` | `scriptId`, `expectedRevision`, `patches` | Apply validated edits atomically and create the next revision. Return a bounded diff. |
| `setSource` | `scriptId`, `expectedRevision`, `source` | Explicit whole-source replacement when a patch is inappropriate. |
| `rename` | `scriptId`, `expectedRevision`, `name` | Change the display name while preserving stable identity and history. |
| `history` | `scriptId`, pagination | Revision summaries and recorded execution references. |
| `diff` | `scriptId`, `fromRevision`, `toRevision` | Return a bounded textual diff. |
| `restore` | `scriptId`, `expectedRevision`, `fromRevision` | Make a historical source the new head revision; do not rewrite history. |
| `delete` | `scriptId`, `expectedRevision` | Soft-delete the asset. History remains recoverable. |
| `undelete` | `scriptId`, `expectedRevision` | Restore a soft-deleted asset without executing it. |

One edit action per call is sufficient initially. A patch action can carry multiple edits that either all succeed or leave the asset unchanged. Language is fixed at creation; use a new asset to change language. Name is a display label, not a filesystem path. Mutating actions accept a stable client mutation ID or reuse the tool-call ID for replay detection.

Extend each `rh_run_script.items` member as a discriminated union:

```json
{
  "items": [
    {
      "scriptId": "script_...",
      "revision": 4,
      "expectedDocument": {
        "lifecycleInstanceId": "...",
        "runtimeSerialNumber": 123
      }
    }
  ]
}
```

The existing `{ "mode": "python|csharp|command", "source": "...", "echo": false }` variant remains valid. Asset-backed items cannot also provide source/mode/echo; language comes from the stored asset. Command macros remain one-off inputs, not editable workspace assets in v1.

Require a revision for asset execution. Resolve that immutable revision before queuing the run. A later edit must not change code already queued for execution. Return `scriptId`, executed revision, source hash, document identity, operation ID, output, and success/failure/unknown outcome.

## Patch semantics

- Support line-based `insert`, `replace`, and `delete` for both languages. Full source is the only scope in v1; there is no inferred C# `RunScript` wrapper.
- Line numbers are 1-based and inclusive. Insert uses `afterLine`, with zero meaning before the first line.
- Require finite safe integers for revisions and line positions, and arrays of single-line strings for inserted/replacement lines. Reject embedded CR/LF characters in a line entry rather than assigning ambiguous coordinates.
- Every edit refers to the same original revision, not the intermediate result of the previous edit. Validate ranges first and apply from the end backward. Reject overlapping edits, duplicate insertion positions, and insertions intersecting replaced/deleted spans. Adjacent non-overlapping edits are valid.
- `expectedRevision` is mandatory for source/head changes. A mismatch returns `REVISION_CONFLICT`, the current revision, and a concise recovery instruction. Never silently relocate stale line patches.
- Normalize stored line endings to LF at ingestion; preserve Unicode and whether the source ends in a newline. Define empty-source and trailing-newline line counts once and use the same function for reads, edits, and diffs. Avoid formatter changes during a patch.
- Optional exact `expectedText` on replacement/deletion checks the selected original span. A mismatch rejects the whole patch. An exact-text replacement action can be considered later; multiple patch styles are unnecessary for the initial workflow.
- Reads and diffs use explicit truncation metadata and pagination/range bounds. Never imply truncated text is the full source. Patch responses include the new revision/hash and a useful local diff, not another complete script.
- A no-op patch returns `changed: false` and retains the same revision. Structural patch validation is local; it does not claim the Python/C# program compiles.

## Persistence and lifecycle

Use a Node-owned `RhinoScriptWorkspace` service backed by versioned records under `<workspaceDir>/.hopper/rhino-scripts/`. Scope assets to the selected workspace, not a process-global map. They survive session rebinding, context compaction, model changes, and a Node restart when that workspace is reopened.

Store schema version, generated asset ID, display name, language, immutable source revisions, revision hashes, timestamps, deletion state, and run records. Use generated IDs as filenames. A caller cannot escape the workspace by putting a path in `scriptId` or `name`.

For v1, keep each asset's revisions and metadata in one versioned record and replace that record atomically using a same-directory temporary file, flush, and rename. Serialize modifications per asset and hold an exclusive workspace writer lock across processes. A second writer returns `WORKSPACE_BUSY` rather than racing the manifest. Define stale-lock recovery using owner identity and liveness checks; never delete a lock just because it is old. Enumerate records for `list` initially to avoid a separately committed index.

Keep source history until explicit asset deletion and later explicit purge. Bound growth with a documented workspace quota; fail before writing with `WORKSPACE_LIMIT_REACHED` rather than silently discarding old revisions. Preserve the current 64,000-character source limit for runnable assets. Diff/read limits are separate. A corrupt record returns a recoverable error and is retained for inspection; do not overwrite it with an empty asset.

Use tool-call/mutation IDs to make local mutations replay-safe. Store the mutation ID and payload hash in the committed record. Same ID and same payload returns the prior result; same ID and a different payload fails. For create, use a durable create-request identity so a lost tool result does not create duplicate assets.

Do not embed scripts in `.3dm` files or treat the asset name as a `.py`/`.cs` file automatically. Import/export, packaging assets alongside CAD files, and a source editor UI are follow-up features. Session history may refer to a revision, but it is not the sole source store.

## Execution and document targeting

1. Resolve and verify the requested source revision, then record a pending run with its immutable source hash. Persist a run ID and RPC operation ID before dispatch so a lost reply can be reconciled.
2. Pass the exact source to the existing Rhino script handler, preserving the 64,000-character limit and Python/C# mode validation. Do not auto-create or run a document when Rhino is offline.
3. Add optional document preconditions to `runRhinoScript` for backward compatibility. Asset runs must provide them. Resolve the observed Rhino runtime serial/lifecycle identity before enqueue and recheck on the Rhino UI thread immediately before execution. Return `DOCUMENT_CHANGED` if the user switched models; do not run against the new active document.
4. Add a minimal query for the active execution document identity if the file management branch has not landed. If it has, reuse its live document handles and contract. Do not infer identity from document name or path, and do not build a second independent document registry.
5. Preserve existing per-turn Undo behavior for actual runs. Local create/patch/restore operations do not open a Rhino transaction and source restoration does not undo geometry. A script can have partial effects before throwing, matching current execution semantics.
6. Record successful/failed runs with captured output and native diagnostics. Keep a bounded output preview and retain operation references. Show the executed revision even when the head has since changed. If journaling fails after native execution, report the real execution outcome plus the recording error, not a false execution failure that invites rerunning.
7. Reconcile unknown execution outcomes through existing retained RPC result lookup. Never auto-run again after a disconnect or execution timeout. If a restart loses the host result, preserve `outcome_unknown` and ask the agent to inspect geometry before considering another explicit run.
8. Preserve original-source line mapping. RhinoCodeRunner may prepend a language shebang; map compiler/runtime locations back when reliable. If native diagnostics lack a usable location, return the raw error without inventing a line number. No separate compiler or preflight execution engine in v1.

A revised script that adds a circle may add another circle when rerun. For an update workflow, the source must deliberately target existing object IDs or tags. Automatic generated-object replacement, parameter dependency tracking, partial function execution, and kernel variable persistence are outside this feature.

## Registration and discoverability

- Add a workspace-bound tool factory instead of a global mutable asset store. Inject it into the embedded extension factory; provide workspace-scoped setup for the CLI extension path too.
- Apply `withBackendGuard` only to tools whose catalog metadata requires a backend. `rh_script` works offline; `rh_run_script` still requires Rhino. Keep source history and diffs available after disconnection.
- Add search keywords for `saved script`, `virtual edit`, `patch`, `revision`, and `Rhino Python/C#`. Update schema diagnostics, progressive tool tests, the read skill's guidance, and Rhino scripting docs.
- Explain the workflow in `mds/reference/rhino-script-boilerplate.md` and `mds/skills/rhino-document/SKILL.md`: create once, patch with the returned revision, run only when requested, inspect object state/output. Keep `gh_edit_script` for code stored inside GH components.
- Use normal tool result rendering for source and diffs. A Monaco editor, browser editor tabs, live Rhino Script Editor synchronization, and full IDE features are not prerequisites.

## Implementation sequence

1. **Contract and generic patch engine.** Define asset/revision/run DTOs, line behavior, conflicts, errors, size limits, and examples. Extract generic line patching only if the existing semantics are compatible; otherwise share lower-level helpers and preserve GH's public behavior.
2. **Persistent workspace.** Implement locked atomic records, revision history, deletion/restore, replay handling, bounded reads/diffs, restart recovery, and corruption errors. Test without Rhino.
3. **Tool/runtime integration.** Add the injected `rh_script` factory, local tool catalog requirements, offline operation, and embedded/CLI workspace lifecycle tests.
4. **Execution by revision.** Extend `rh_run_script` union, resolve immutable source, add backend document preconditions, preserve RPC operation IDs, and journal completed or uncertain runs. Add protocol fixtures where the optional execution arguments need coverage.
5. **Agent docs and output.** Add compact diff rendering and source-error references, update tool schemas and routing, and test discovery. Retain one-off scripts and direct macros.
6. **Native verification.** Exercise Python and C# revision runs, document switching, Undo, output/errors, and interrupted requests in Rhino 8. Record platform/build details and any unavailable checks.

Likely new files: `src/tools/rh-script.ts`, `src/services/rhino-script-workspace.ts`, `src/services/rhino-script-store.ts`, `src/services/source-line-patches.ts`, and `src/types/rhino-script-workspace.ts`. Existing changes include `src/index.ts`, `src/host/pi-runtime.ts`, tool catalog/handlers, `src/infra/runtime-rpc.ts`, the Rhino operation adapter/executor, and RhinoCodeRunner's diagnostic mapping.

## Acceptance and verification

- Create a 100-line Python or C# script, read a small numbered range, replace one line, and run the new revision without sending all 100 lines back from the agent.
- Insert at the beginning/end, replace/delete multiple lines, preserve a final newline, handle empty source and Unicode, reject out-of-range/overlapping edits, and leave no partial write after one invalid edit.
- A stale revision fails; a no-op does not add history; restoring old source creates a new revision; rename keeps IDs stable; deleted scripts cannot run until restored.
- Concurrent calls to one asset and a second writer process cannot lose updates. Duplicate create/patch mutation IDs do not duplicate assets/revisions. Simulated crash before/after atomic rename yields either the previous or complete new record.
- Resume a session, switch models, rebind sessions, restart Node, and change the agent model. Source and history remain available only in the intended workspace. Switching workspace does not expose another workspace's scripts.
- All source actions work with Rhino disconnected and do not call the backend. Asset execution while disconnected fails without changing the source.
- Queue revision 2, patch to revision 3, and verify the run executes revision 2. Switch the active Rhino model before execution and verify rejection rather than mutation of the wrong document.
- Python and C# output/errors include asset identity and executed revision. Shebang handling does not misreport known source line locations. Compilation/runtime failure retains editable source.
- One-off Python/C#/command calls still work. GH patch scope and line behavior remain unchanged.
- Run errors can leave geometry changes; report them accurately. A lost result does not cause automatic re-execution. Rhino Undo affects run geometry but leaves asset history unchanged.

Run focused Vitest suites during implementation, then `pnpm test`, `pnpm build`, `pnpm test:rpc-cross-language`, `dotnet test dotnet/Hopper.Core.Tests/Hopper.Core.Tests.csproj`, `dotnet test grasshopper-plugin.Tests/grasshopper-plugin.Tests.csproj`, and `pnpm build:gh-plugin`. Add native Rhino smoke tests for execution; storage/patch tests do not prove Rhino behavior.

## Relationship to document management

The independent plan in `plan/document-file-management`, `docs/document-file-management-plan.md`, owns native CAD file lifecycle operations and full document inventory. This script workspace can ship first with a minimal execution identity query. If file management ships first, use its document handles directly.

Both branches touch tool catalog registration, `rh_run_script` integration points, protocol types, and runtime transactions. Coordinate those edits during implementation. Keep script asset persistence independent of CAD file saving: SaveAs of a `.3dm` must not rename or move workspace scripts silently.

No Rhino execution or source editing prototype was performed while writing this plan.
