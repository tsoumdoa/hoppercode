# Editable Rhino script workspace plan

Status: Node implementation complete on this branch. Asset execution requires the document-management branch's native identity/settings queries and precondition enforcement. Native platform checks are tracked below.

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
| `list` | Optional name filter, `includeDeleted`, and pagination | List this workspace's scripts and current revisions without dumping source. |
| `get` | `scriptId`, optional `revision`, `startLine`, `endLine` | Return exact source range with line numbers and revision metadata. |
| `patch` | `scriptId`, `expectedRevision`, `patches` | Apply validated edits atomically and create the next revision. Return a bounded diff. |
| `setSource` | `scriptId`, `expectedRevision`, `source` | Explicit whole-source replacement when a patch is inappropriate. |
| `rename` | `scriptId`, `expectedRevision`, `name` | Change the display name while preserving stable identity and history. |
| `history` | `scriptId`, pagination | Revision summaries and recorded execution references, including soft-deleted assets. |
| `getRun` | `runId` | Read a durable execution record without contacting Rhino. |
| `reconcileRun` | `runId` | Query the original host's retained operation result when available; never dispatch source. |
| `getExecutionTarget` | None | Read the active Rhino document identity for a subsequent run; return explicit no-document state if none exists. |
| `diff` | `scriptId`, `fromRevision`, `toRevision` | Return a bounded textual diff. |
| `restore` | `scriptId`, `expectedRevision`, `fromRevision` | Make a historical source the new head revision; do not rewrite history. |
| `delete` | `scriptId`, `expectedRevision` | Soft-delete the asset. History remains recoverable. |
| `undelete` | `scriptId`, `expectedRevision` | Restore a soft-deleted asset without executing it. |

One edit action per call is sufficient initially. A patch action can carry multiple edits that either all succeed or leave the asset unchanged. Language is fixed at creation; use a new asset to change language. Name is a display label, not a filesystem path. Mutating actions accept a stable client mutation ID or reuse a namespaced tool-call ID for replay detection.

Use one monotonically increasing asset revision for source and metadata changes. Each revision stores the effective name, language, source, hash, and deletion state. Rename/delete/undelete create revisions without changing the source hash; appending a run record does not advance the asset revision. `restore` copies historical source into a new live revision while retaining the current name; undelete is a separate action. Reads/history can inspect a deleted asset, but new execution is rejected while its current head is deleted. Queued execution pins the validated source and may complete after deletion; deleting an asset is not execution cancellation.

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

When document settings inspection is available, `getExecutionTarget` also returns the target's units, tolerances, and `settingsRevision` from the shared document settings reader. Asset runs may supply `expectedSettingsRevision` to reject a units/tolerance change between inspection and execution with `DOCUMENT_SETTINGS_CHANGED`. Record the actual settings snapshot at run start in the run journal. The check does not prevent the script itself from changing settings later. Source patching never changes document settings. Reuse the document-management contract; an older backend must report the inspection/precondition as unsupported rather than fabricate defaults or silently ignore a supplied revision.

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

Use a Node-owned `RhinoScriptWorkspace` service backed by versioned records under `<scriptWorkspaceDir>/.hopper/rhino-scripts/`. Introduce `scriptWorkspaceDir` separately from the existing session `workspaceDir`: `src/host/config.ts` currently places session workspaces below `instances/<lifecycleInstanceId>`, and the Rhino launcher assigns a fresh lifecycle ID on restart. That path cannot provide normal restart persistence.

For the embedded host, default `scriptWorkspaceDir` to `<dataDir>/workspaces/default`, with an absolute `--script-workspace` option and `HOPPER_SCRIPT_WORKSPACE` fallback for choosing another workspace. The CLI extension defaults to its explicitly selected project working directory. Record a durable workspace UUID in its manifest and return it with asset/run references. Leave session paths and transport lifecycle identity unchanged. Resuming a session resolves assets in the configured script workspace; an ID from a different workspace returns `WORKSPACE_MISMATCH` rather than searching unrelated folders. Do not silently move scripts when opening or saving a CAD document.

Multiple Rhino hosts may intentionally use the default script workspace. They share source assets while execution remains bound to each host's lifecycle and document. No workspace writer lock is held for a whole session or across native execution. Rebinding a session releases the old service reference and reuses/acquires the configured workspace service; it does not close a service still used by another runtime. Test actual `HopperCodeRestart` with a new lifecycle ID, not only restarting Node with identical arguments.

Store schema version, generated asset ID, display name, language, immutable source revisions, revision hashes, timestamps, deletion state, and run records. Use generated IDs as filenames. A caller cannot escape the workspace by putting a path in `scriptId` or `name`.

For v1, keep each asset's revisions and metadata in one versioned record and replace that record atomically using a same-directory temporary file, flush, and rename. Serialize modifications within a process and acquire an exclusive workspace writer lock only for each short storage transaction, including quota checks. A second writer returns `WORKSPACE_BUSY` rather than racing the record. Validate lock release, atomic replacement, and crash recovery on Windows and macOS. Define stale-lock recovery using owner identity and liveness checks; never delete a lock just because it is old. Enumerate records for `list` initially to avoid a separately committed index. Lock or quota failure cannot block read-only inspection.

Keep source history through soft deletion. Bound growth with a documented workspace quota; fail before writing with `WORKSPACE_LIMIT_REACHED` rather than silently discarding old revisions. Preserve the current 64,000-character source limit for runnable assets. Diff/read limits are separate. A corrupt record returns a recoverable error and is retained for inspection; do not overwrite it with an empty asset. Since purge is outside v1, provide a host configuration to raise the quota and report the storage path and usage so the limit is recoverable. Reserve bounded space for finalizing admitted run records; a full source quota must not prevent recording that native execution completed.

Use IDs namespaced by workspace, persistent session ID, and tool-call ID to make local mutations replay-safe. Store each retained mutation ID, canonical payload hash, and result revision in the committed record. Same ID and same payload returns the prior result even if the head advanced; same ID and a different payload fails. For create, derive a stable asset ID from the namespaced request identity or use an equivalent atomically durable mapping, so a lost tool result does not create duplicate assets. Retain replay records with the revision history; checking only the most recent mutation is insufficient.

Do not embed scripts in `.3dm` files or treat the asset name as a `.py`/`.cs` file automatically. Import/export, packaging assets alongside CAD files, and a source editor UI are follow-up features. Session history may refer to a revision, but it is not the sole source store.

## Execution and document targeting

1. Derive each run identity from workspace UUID, persistent session ID, tool-call ID, and item index. Consult the durable run record before new target validation or dispatch: the same identity/payload returns its prior result or reconciles it; a different payload returns `MUTATION_ID_CONFLICT`. Then resolve and verify the requested source revision and persist a run ID, original lifecycle ID, document identity, source hash, canonical payload hash, and chosen RPC operation ID before any dispatch. Store runs as separate atomic records so finalization does not rewrite the asset's entire history.
2. Pass the exact source through a structured execution service that calls `RuntimeRpc.invoke` with the persisted `operationId`. Refactor `rhino-script-handlers.ts` to format its result afterward: the current string-returning handler and `Requester.request` discard operation envelopes and expose no per-call operation ID. Preserve the 64,000-character limit and Python/C# validation. Do not auto-create or run a document when Rhino is offline.
3. Add optional document preconditions to `runRhinoScript` for backward compatibility. Asset runs must provide them. Resolve the observed Rhino runtime serial/lifecycle identity before enqueue and recheck on the Rhino UI thread immediately before execution. Return `DOCUMENT_CHANGED` if the user switched models; do not run against the new active document.
4. Back `rh_script.getExecutionTarget` with a minimal query for active execution document identity if the file management branch has not landed. If it has, reuse its live document handles and contract. Do not infer identity from document name or path, and do not build a second independent document registry. Validate the Rhino transaction's bound document at the same execution boundary: current owner-wide transaction flags alone do not prove its undo record belongs to the target. Implement that narrow prerequisite here if this branch ships first, or reuse the file branch's document-aware transaction segments.
5. Preserve existing per-turn Undo behavior for actual runs. Local create/patch/restore operations do not open a Rhino transaction and source restoration does not undo geometry. A script can have partial effects before throwing, matching current execution semantics.
6. Record successful/failed runs with captured output and native diagnostics. Keep a bounded output preview and retain operation references. Show the executed revision even when the head has since changed. If journaling fails after native execution, report the real execution outcome plus the recording error, not a false execution failure that invites rerunning.
7. Reconcile unknown execution outcomes through existing retained RPC result lookup. Never auto-run again after a disconnect or execution timeout. If a restart loses the host result, preserve `outcome_unknown` and ask the agent to inspect geometry before considering another explicit run.
8. Preserve original-source line mapping. RhinoCodeRunner may prepend a language shebang; map compiler/runtime locations back when reliable. If native diagnostics lack a usable location, return the raw error without inventing a line number. No separate compiler or preflight execution engine in v1.

Run states are `prepared`, `dispatching`, `completed`, `failed`, `notStarted`, and `outcome_unknown`. Admit a run and advance its state atomically under the short workspace transaction with compare-and-swap on record version and a unique runner claim. The claim identifies its owning process/start identity and in-process execution; only that owner can move new work from prepared to dispatching. Concurrent replays inspect the existing record and cannot take over or dispatch it. Persist `dispatching` before entering the transport, and release/finalize the claim on ordinary completion/cancellation. A timeout or expired lease alone never proves the owner stopped.

An abandoned `prepared` record can become `notStarted` only when its runner is proven dead or the live owner confirms it will not dispatch. A concurrent replay must not mark a live owner's prepared work not started. A recovered `dispatching` record is uncertain even when result lookup says not found, because execution may have completed and its retained result expired. Reconciliation checks the original lifecycle; it cannot query a new host and interpret absence as non-execution. `getRun` is offline; `reconcileRun` needs the original reachable backend and `getExecutionTarget` needs the currently connected backend. None of these actions runs source. Persist terminal results or uncertainty through the same atomic store. No source/quota lock is held while awaiting Rhino.

For any batch containing an asset-backed item, check its namespaced call identity and canonical batch payload hash, then look up existing item records before validating current asset state. A replay returns/reconciles the previously recorded batch, even if an asset has since been renamed or deleted; it never starts missing or previously unexecuted items. For a genuinely new batch, prevalidate all item shapes and source revisions before its first run and persist the item inventory, including inline items in a mixed batch. Process items sequentially, stopping at the first failed, not-started, or uncertain execution, and mark remaining items `notRun`. Persist skipped states so replay cannot accidentally execute them. A client timeout/abort must not permit later items to proceed while an earlier one may still be running. Honor the tool abort signal before dispatch and between items without claiming that it interrupted native execution. Preserve current continue-on-error behavior only for legacy inline-only batches, and document the distinction. A new explicit tool call can intentionally run a revision again; a replay of the same call cannot.

A revised script that adds a circle may add another circle when rerun. For an update workflow, the source must deliberately target existing object IDs or tags. Automatic generated-object replacement, parameter dependency tracking, partial function execution, and kernel variable persistence are outside this feature.

## Registration and discoverability

- Add a workspace-bound tool factory instead of a global mutable asset store. Inject it into the embedded extension factory; provide workspace-scoped setup for the CLI extension path too.
- Apply `withBackendGuard` only to tools whose catalog metadata requires a backend. Do not guard the entire `rh_script` tool; its source/history actions work offline, while `reconcileRun` and `getExecutionTarget` perform their own action-specific backend checks. `rh_run_script` still requires Rhino. Keep source history and diffs available after disconnection.
- Add search keywords for `saved script`, `virtual edit`, `patch`, `revision`, and `Rhino Python/C#`. Update schema diagnostics, progressive tool tests, the read skill's guidance, and Rhino scripting docs.
- Explain the workflow in `mds/reference/rhino-script-boilerplate.md` and `mds/skills/rhino-document/SKILL.md`: create once, patch with the returned revision, explicitly execute when needed for the user's modeling request, and inspect object state/output. This does not add per-run user approval. Keep `gh_edit_script` for code stored inside GH components.
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
- Restart Hopper with a newly generated lifecycle ID and verify source persistence in the stable script workspace. Run two hosts against it and verify short storage transactions serialize without preventing concurrent inspection or independent native execution.
- Replay create, edit, and execution calls after the source head has advanced. The exact old request returns its prior result; a changed payload with the same identity fails. An intentionally new execution call can run the same revision again.
- Crash immediately before and after transport dispatch, expire retained results, switch lifecycle, lose the completion journal write, and fill the source quota. Inspection/reconciliation remains usable and none of these conditions re-executes source.
- In an asset-backed batch, fail or lose the first run's result and verify every later item is reported `notRun`. Test cancellation during prevalidation, between items, and while native execution is pending.
- Replay a completed mixed/asset batch after source deletion and verify its recorded results are returned without source validation or execution. Replay a partially completed batch and verify skipped/missing items stay unexecuted.
- Race two hosts on admission and reconciliation of the same run. Only one runner owns dispatch; a live prepared run cannot be finalized by its observer, and a dead dispatching runner is never replaced by another executor.

Run focused Vitest suites during implementation, then `pnpm test`, `pnpm build`, `pnpm test:rpc-cross-language`, `dotnet test dotnet/Hopper.Core.Tests/Hopper.Core.Tests.csproj`, `dotnet test grasshopper-plugin.Tests/grasshopper-plugin.Tests.csproj`, and `pnpm build:gh-plugin`. Add native Rhino smoke tests for execution; storage/patch tests do not prove Rhino behavior.

## Relationship to document management

The independent plan in `plan/document-file-management`, `docs/document-file-management-plan.md`, owns native CAD file lifecycle operations and full document inventory. This script workspace can ship first with a minimal execution identity query. If file management ships first, use its document handles directly.

Both branches touch tool catalog registration, `rh_run_script` integration points, protocol types, and runtime transactions. Coordinate those edits during implementation. Keep script asset persistence independent of CAD file saving: SaveAs of a `.3dm` must not rename or move workspace scripts silently.

No Rhino execution or source editing prototype was performed while writing this plan.

## Adversarial review disposition

The 2026-09-06 subagent review found undefined execution replay identity and unsafe continuation of asset-backed batches after uncertain outcomes. The run identity/state machine, inspection/reconciliation actions, and stop policy above resolve those design gaps. Local review also found lifecycle-scoped storage, loss of RPC operation metadata in the current handler, ambiguous metadata revisions, and unrecoverable quota behavior. The revised plan specifies stable storage, a structured execution service, asset revision semantics, and reserved run-finalization capacity. These are plan corrections; implementation must still prove storage locking, native document preconditions, and failure recovery.


## Implementation record, 2026-09-06

Implemented persistent Python/C# assets, revision-checked original-source patches, bounded reads and diffs, metadata history, soft deletion, restore, replay-safe mutation identities, and workspace-scoped IDs. `rh_script` source actions work offline through extension-bound services. Embedded storage uses the stable data directory, with workspace/quota overrides; CLI binding uses the selected project and persistent session ID.

Asset and mixed `rh_run_script` batches now persist their complete pinned item inventory before dispatch, then journal separate run records. Calls retain operation IDs, runner claims, states, settings and bounded output. Replays never dispatch source; unknown outcomes query only the original lifecycle. Terminal results supersede concurrent uncertainty. Mixed inline items also pin a document target. Abort signals are checked at transport send, and later batch items stop after failure, uncertainty or cancellation. Existing inline-only batches retain their continue-on-error behavior.

The source store uses short exclusive writer transactions, file flush/atomic rename, and dead-process checks for stale locks. Completion capacity reserves 128,000 bytes per nonterminal run plus missing run-record source storage, then releases the reservation after a terminal record is durable. Source-quota exhaustion cannot prevent admitted run completion. Unreadable writer locks and interrupted recovery guards require manual inspection with writers stopped. They are never removed based on age.

Verification completed on macOS with Node 26.8.1: 416 Vitest tests passed, production TypeScript/UI build passed, authenticated cross-language RPC smoke passed, and 201 Hopper.Core tests passed. New tests cover original-coordinate patches, Unicode/newlines, mutation replay after history advances, workspace restart under a new lifecycle, actual independent-process writer contention, offline tool registration/session rebinding, batch replay after deletion, pinned source, unknown outcomes, cancellation before transport send, quota finalization, structured native errors, and terminal-result races.

The combined branch passed native Python/C# execution against the shared document/settings DTOs, stale-target rejection on the UI thread, and grouped Undo. See [integration verification](document-script-integration-verification.md) for results and remaining checks, including actual HopperCodeRestart and platform crash behavior around flush/rename. This branch adds no native registry and depends on `listRhinoDocuments` and native `runRhinoScript.expectedDocument` from document management. Native diagnostics remain raw when RhinoCode does not expose a reliable user-source location; no line number is guessed from library frames. The known shebang insertion behavior remains documented.
