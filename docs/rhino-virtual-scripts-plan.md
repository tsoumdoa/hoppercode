# Editable Rhino script workspace

Implemented on `plan/rhino-virtual-scripts` and combined with document management on `feat/document-script-integration`. The original 2026-09-06 plan remains in Git history. Current test results and remaining native checks are in [integration verification](document-script-integration-verification.md).

## Agent workflow

Create Python/C# source once with `rh_script`, read a numbered range, patch against its revision, inspect the diff, and explicitly execute the selected revision with `rh_run_script`. Source edits never execute code or replace previously generated geometry. Existing inline Python/C#/command calls and `gh_edit_script` remain available.

| Action | Behavior |
| --- | --- |
| `create`, `list`, `get` | Persistent named source with bounded inventory and numbered reads |
| `patch`, `setSource` | Atomic edits guarded by `expectedRevision` |
| `rename`, `delete`, `undelete` | Stable IDs, metadata history, and soft deletion |
| `history`, `diff`, `restore` | Inspect revisions/runs; restoration creates a new source revision |
| `getExecutionTarget` | Inspect the active native document identity and units/tolerances |
| `getRun`, `reconcileRun` | Inspect execution records; reconcile against retained native results without resubmitting |

Line patches use 1-based coordinates in the original revision; insertion uses `afterLine: 0` before the first line. Overlapping or invalid patches fail as a whole. Source normalizes line endings to LF, preserves logical blank lines and trailing-newline state, and is limited to 64,000 characters. A no-op retains the existing revision. Deleted scripts cannot run until undeleted.

Reads return at most 200 complete lines and 16,000 source characters. Long lines use `characterOffset` and a continuation offset, then continue to subsequent lines. History paginates both revisions and run IDs. Diffs provide bounded previews.

## Persistence and replay

Embedded storage uses a stable data-directory workspace; CLI storage binds to the selected project. `HOPPER_SCRIPT_WORKSPACE` and `HOPPER_SCRIPT_WORKSPACE_QUOTA_BYTES` override the path and quota. Host instance lifecycles do not own source history. Local source/history/run inspection works offline.

Each asset stores immutable revisions and replay records in one atomic JSON record. IDs include the workspace identity and cannot contain paths. A mutation's persistent session/tool-call identity and payload hash return the prior result on replay, even after history advances. Reusing that identity with another payload fails. Mutation identity remains unique across the workspace.

Short exclusive writer transactions protect quota checks and file flush/rename. They never remain locked while awaiting native execution. Dead-writer recovery requires evidence that the owning process ended; an old timestamp is insufficient. Unreadable locks and interrupted recovery guards require manual inspection. Corrupt records remain available for inspection rather than being replaced with empty data.

The default quota is 64 MiB. History is retained through soft deletion; purge is outside this change. Admitted runs reserve 128,000 bytes each for bounded completion records, plus missing run-record source storage. Increasing the configured quota permits further history without silently deleting old revisions.

## Execution

Asset items identify `scriptId`, `revision`, and `expectedDocument`. The latter contains `documentId`, `lifecycleInstanceId`, and optional `settingsRevision`. Native code validates the target on the UI thread immediately before execution. It rejects a switched document or changed units/tolerances. The script itself can still modify settings.

For a batch containing an asset:
1. Check the durable call identity before validating current asset state.
2. Pin every item's source, target, lifecycle, and RPC operation ID, then atomically save the batch inventory.
3. Dispatch sequentially under the original runner's claim. Persist `dispatching` before transport send.
4. Record output and actual results. Stop after failure, cancellation, or uncertainty; remaining items become `notRun`.
5. Replay or reconcile the existing inventory without dispatching missing, prepared, or skipped items.

Run states are `prepared`, `dispatching`, `completed`, `failed`, `notStarted`, `outcome_unknown`, and `notRun`. Version checks and runner ownership prevent concurrent observers from taking over execution or replacing a known terminal result with uncertainty. A dead runner's prepared item can become `notStarted`; a dispatched item remains uncertain unless its original host retains a terminal result.

Mixed batches also pin inline items. Legacy inline-only batches retain continue-on-error behavior. Cancellation is checked before transport send and between items; it does not claim to interrupt native execution. A new explicit call may intentionally run the same revision again.

Native script failure may leave geometry changes. Journal-write failure after execution reports the known execution outcome plus the recording error. Native result loss or host restart never triggers automatic execution. Source history is independent of Rhino Undo and CAD SaveAs.

## Deliberate limits

- No synchronization with Rhino Script Editor, source editor UI, import/export, persistent kernel variables, partial-function execution, or automatic generated-object replacement.
- Source/error references identify the executed revision. Native diagnostics remain raw when reliable user-source line locations are unavailable.
- Actual `HopperCodeRestart`, end-to-end asset creation through native execution, and platform crash durability remain checks described in the verification record.
- Workspace-wide mutation lookup currently scans retained script histories. Changing replay identity scope or introducing an index is a separate storage-contract decision.
