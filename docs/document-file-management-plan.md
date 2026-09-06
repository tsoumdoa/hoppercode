# Rhino and Grasshopper file management plan

Status: implementation plan only. No runtime changes made.

Date: 2026-09-06. Base: `26d0a2c`, from `t3code/self-host-pi-rhino`.

Branch: `plan/document-file-management`.
Worktree: `/Users/tomohirosugeta/repo/hoppercode-file-management`.

## Outcome

Give the agent explicit tools to inspect, create, open, activate, save, save as, and close Rhino and Grasshopper documents. A request must identify the document it will affect, handle unsaved changes deliberately, and return the resulting document and file state. The agent must be able to open a document when no document is currently open.

The first release supports native `.3dm`, `.gh`, and `.ghx` files. File dialogs must not be required for normal successful operations. Use Rhino 8 on macOS and Windows as the compatibility targets.

An example workflow is: list documents, save an existing unnamed GH definition to an absolute `.gh` path, close that definition, reopen it, then continue editing the reopened canvas. Rhino should support the same workflow with a `.3dm` file and its geometry.

## Existing code and constraints

- [Tool catalog](../src/tools/catalog.ts) contains no document management tools.
- [Command validator](../src/services/rhino-script-validator.ts) rejects `Open`, `New`, `Close`, and `SaveAs` in command mode. `_Save` is allowed. Python and C# are general script execution paths; this regex is not a sandbox.
- [Rhino script executor](../dotnet/Hopper.Rhino/Operations/RhinoScriptExecutor.cs) requires an active RhinoDoc and redraws that document after execution. It is unsuitable as the implementation of document lifecycle operations.
- [Grasshopper readiness](../src/infra/grasshopper-readiness.ts), [Core routing](../dotnet/Hopper.Core/Operations/HostOperationRouter.cs), and [GH adapter](../dotnet/Hopper.Grasshopper/GrasshopperOperationAdapter.cs) all currently assume an active GH document. All three need operation-specific requirements.
- [Runtime RPC](../src/infra/runtime-rpc.ts) opens a turn transaction automatically for owner-classified mutations. File operations must not start a geometry transaction just to open or close a file.
- [Rhino transaction](../dotnet/Hopper.Rhino/Operations/RhinoAgentTransaction.cs) cancellation ends its undo record without rolling back geometry. [GH transaction](../dotnet/Hopper.Grasshopper/AgentTransaction.cs) cancellation restores a snapshot. File transitions must commit the existing editing segment, not cancel it.
- [Rhino monitor](../dotnet/Hopper.Rhino/RhinoDocumentStatusMonitor.cs) and [GH tracker](../dotnet/Hopper.Grasshopper/ActiveGrasshopperDocumentTracker.cs) publish presence/name information but do not expose a full document inventory with stable handles.
- C# production references target RhinoCommon `8.0.23304.9001`. Do not adopt methods from current online documentation without compiling against the pinned SDK.

## Tool contract

Add two discoverable tools, `rh_document` and `gh_document`, with the same action vocabulary. Each call performs one action. Avoid a batch that could silently resolve later actions against a different active document.

| Action | Required input | Result and semantics |
| --- | --- | --- |
| `list` | None | Open documents in the connected Rhino process, active handle, and host capabilities. Empty is valid. |
| `get` | `documentId` | Current metadata for that exact live document. |
| `browse` | Absolute directory `path`, optional cursor | Return a bounded, nonrecursive list of subdirectories and native CAD files so the agent can discover paths. No document or GH startup required. |
| `new` | `expectedActiveDocument`; explicit template path if needed; `affectedDocuments` when replacing | Create and activate an unnamed document. Report any replacement. |
| `open` | Absolute native-file `path`, `expectedActiveDocument`, `affectedDocuments` when replacing | Open and activate, or activate an already-open matching file. Report `alreadyOpen`. |
| `activate` | `documentId` | Activate that live document without opening another copy. |
| `save` | `documentId`, `expectedStateToken` | Save to its existing path. An unnamed document returns `PATH_REQUIRED`; use `saveAs`. |
| `saveAs` | `documentId`, `expectedStateToken`, absolute `path` | Save under the new path and make that path the document's current identity. |
| `close` | `documentId`, `expectedStateToken`, `onUnsaved` | Close only the selected document. Return actual active-document state afterward. |

`list` and `get` return `documentId`, `kind`, `name`, `path` or null, `isActive`, `isModified`, `isReadOnly` when known, and `stateToken`. Include `lifecycleInstanceId`. Use a host-issued live handle backed by Rhino runtime serial number or GH document identity; never resolve by display name. Reopening the same path produces a new handle unless it was already open. Handles from a previous host lifecycle are invalid.

The state token changes when the host observes relevant document edits, path changes, or lifecycle changes. It is an optimistic concurrency check, not a content hash. Validate it and the target handle on the UI thread immediately before the operation. For actions that depend on the active document, also require the observed active handle or explicit null. Reject a changed target instead of affecting the newly active document.

For open/new, `expectedActiveDocument` is a live handle or explicit null, and `affectedDocuments` is a list of `{documentId, expectedStateToken, onUnsaved, savePath?, overwrite?}`. Require an entry for every document the native action would replace or discard, including a currently clean document that could become dirty before execution. Reject missing or stale entries before replacement. A platform where the action adds a window without replacing anything accepts an empty list. A document created incidentally by lazy GH startup must not be discarded without checking that it is still empty and unchanged. `activate` also checks the observed active handle when the operation would change it.

`browse` reports canonical absolute paths, file/directory kind, supported extension, and pagination without reading arbitrary file contents or recursing. Bound results and report unreadable entries. This is necessary because the embedded agent's existing `read` tool only reads skill-library Markdown; it has no general directory listing. Implement the filesystem query once in the backend and reuse it from both tools, independent of an active document or loaded GH adapter.

### State-token coverage

Maintain a monotonic observed-change revision for every managed live document, not only the active canvas. Define and test an event coverage table for Rhino object addition/deletion/replacement/attributes, layer/material/document tables, path and dirty-state changes, Undo/Redo, and GH component/port/wire/persistent-value changes while its solver is disabled. An edit to an already-dirty document must still advance the revision. Solver completion alone is not evidence of a persisted edit and must not continuously invalidate an unchanged definition.

Reuse native monotonic change counters where the pinned SDK guarantees the required coverage, otherwise add owner-specific subscriptions and native-write scopes. Native spikes must prove the coverage before tokens are advertised as protecting discard operations. If an edit class lacks reliable notifications, use a verified persistent-state fingerprint at observation and destructive execution, or return `STATE_VALIDATION_UNAVAILABLE` for destructive requests on that target. Do not silently downgrade to the dirty boolean or claim that the existing monitors cover all edits. Subscribe/unsubscribe on inventory add/remove and invalidate handles before disposing native objects.

Capabilities describe native multi-document behavior, supported file types, and any unavailable action. `list` on an unloaded GH adapter returns capability state without launching GH; mutating GH actions may use existing lazy startup. `get` of a stale handle does not launch another session.

## Paths, overwrites, and unsaved changes

- Paths belong to the machine running Rhino. Require absolute paths and supported extensions. Validate files/directories in the backend, where the write occurs. Do not depend on the Node working directory.
- Default `createDirectories` and `overwrite` to false. They can be explicitly enabled when the request authorizes them. Use normalized/canonical path comparison with the platform's actual case and symlink behavior, not unconditional lowercasing.
- `save` may update its own existing file. `saveAs` to a different existing file requires `overwrite: true`; to its own path, use save semantics. Check for external file changes since the last observed save/open and return `FILE_CHANGED_EXTERNALLY` unless an explicit overwrite policy covers them.
- Before SaveAs, compare its canonical destination against all live documents of that kind. If another document owns it, return `DESTINATION_OPEN_IN_OTHER_DOCUMENT` even with `overwrite: true`. Resolve that document separately first; SaveAs cannot silently retarget two live documents to one file.
- `onUnsaved` is `fail`, `save`, or `discard`, defaulting to `fail`. `save` may include a `savePath` for an unnamed affected document and its overwrite options. A failed save must stop the close/replacement. `discard` must originate from the user's existing instruction or a specific answer about losing those changes.
- Open/new must report and handle any document they will replace. Do not silently save a dirty document as a side effect of an SDK convenience method.
- Reuse authorization already present in the conversation. Saving to a requested path does not need another approval. Ask only when a missing destination, ambiguous target, or unresolved loss of unsaved work prevents execution.
- No modal save/open/overwrite dialogs in the ordinary path. A locked file, missing plugin prompt, or other native interaction that cannot be suppressed must produce a specific limitation instead of a claimed success.
- Return structured domain errors such as `DOCUMENT_NOT_FOUND`, `DOCUMENT_CHANGED`, `PATH_REQUIRED`, `PATH_NOT_FOUND`, `UNSUPPORTED_EXTENSION`, `DESTINATION_EXISTS`, `UNSAVED_CHANGES`, `FILE_CHANGED_EXTERNALLY`, `FILE_LOCKED`, `HOST_BUSY`, and `UNSUPPORTED_ON_PLATFORM`. Preserve useful native error text.

For external-file checks, retain the last verified file identity/size/mtime and a content digest when needed to distinguish an unchanged file from replacement. Revalidate just before native writing and use native locking/backup support. External-writer exclusion depends on filesystem and native-writer guarantees; a separate stat check is not an atomic compare-and-swap. Document this limit and test replacement races instead of claiming overwrite races are impossible.

Return operation stage outcomes and per-document/file side effects, not only a success boolean. A save may succeed before a later close/open fails, and failure to refresh metadata does not mean no file was written. Include whether the pre-save completed, which documents remain open, known resulting paths, and whether any outcome is uncertain. Preserve successful earlier effects; do not replay the whole compound action to retry its failed final step.

## Native implementation

Keep shared DTOs and operation policy in Core, Rhino document operations in `Hopper.Rhino`, and GH document operations in `Hopper.Grasshopper`. Core must not acquire RhinoCommon or Grasshopper references, and Rhino must not acquire a Grasshopper reference.

### Rhino

Implement a native document service behind an injectable executor interface. Enumerate visible documents, resolve exact handles, and use the native writer with backup/locking behavior. SaveAs must change the live document path only on success; writing an unrelated headless copy is not SaveAs.

Run an SDK spike before selecting the open/new/activate/close calls. Rhino's documented `RhinoDoc.Open` differs by platform: Windows replaces the active model and may save it; Mac opens another document window. Resolve unsaved policy before invoking that operation. Do not promise multiple models within a Windows process. Closing the last model must keep the Rhino application and Hopper host running; validate what empty or replacement document state the platform actually supports and report it.

Prefer native APIs. If Rhino 8 exposes an operation only as a command, use a narrowly constructed internal macro with escaped paths and known prompt answers. Do not pass arbitrary user macro text through the document service or remove the public command denylist as a shortcut. Resolve and verify the target before and after any macro.

### Grasshopper

Use `GH_DocumentIO` and the document server to load/save definitions. Opening must load, register once, activate the canvas document, and refresh the tracker. Resolve an already-open canonical path instead of adding duplicate documents. Surface load warnings and missing-component information.

Saving must include script source, persistent parameter data, component state, and wires. Verify both `.gh` and `.ghx`, current-path updates, and the dirty flag after SaveAs. Implement close through document-server/canvas APIs after resolving unsaved policy; avoid dialog-producing convenience APIs in unattended execution. Do not treat a definition embedded in a cluster as a top-level file without an explicit supported policy.

Rhino and GH documents are independent targets. Closing a Rhino model must not implicitly close or save all GH definitions. Report reference/association warnings when known, without claiming to repair external references. Opening a GH definition can run its solver; document actual native behavior and do not add a second automatic solve unless required.

## Routing, ordering, and undo

1. Add separate read and mutation RPC operations for each owner, for example `listRhinoDocuments`, `getRhinoDocument`, `manageRhinoDocument`, and GH equivalents. List/get are queries; all lifecycle and write actions are retained mutations with operation IDs. Add shared `browseDocumentFiles` as a Core-routed filesystem query with no native document requirement or GH startup.
2. Extend operation metadata with active-document requirements and undo behavior. Separate `requires adapter loaded` from `requires active document`. Open/new/list must work with zero documents. Save/get/close resolve the requested handle rather than relying on whichever document is active. Handle the unloaded-GH `list` response through Core capability status before adapter dispatch, and exempt that query from Node's automatic GH startup. An empty list with an unavailable/not-loaded capability is different from a loaded adapter reporting zero documents.
3. Update TypeScript and C# operation inventories, schema, metadata, fixtures, adapters, and the cross-language checks together. Retain protocol v2 envelopes; use additive operations with domain errors in result data. An older backend must return a clear unsupported capability.
4. Treat every file mutation and activation as a document transition boundary. Finish any editing transactions that could be affected before the transition, retaining their Undo entry. Clear the corresponding Node transaction flags and lazily begin a new editing segment for later geometry/canvas edits. A failed transition also leaves the previous segment finished.
5. Serialize boundary preparation and the native operation through the existing ordered dispatcher. The backend must enforce the boundary for all callers; a Node-only flag change is insufficient. Do not split commit/switch across independently interleavable calls. Abort a transition if transaction completion fails.
6. A file save/close is not undone by Rhino/GH geometry Undo or by canceling a later agent turn. In particular, do not restore a GH snapshot from before a save and make the in-memory definition diverge from the file silently.
7. Publish refreshed document state, invalidate document-scoped canvas/object caches as needed, and return authoritative post-operation state. Audit `guid-shortener`, canvas caches, and subscribers for assumptions about the old active document. Never reuse stale target IDs across documents.
8. Use existing mutation result retention and lookup after a lost reply. Do not replay save/open/close after `outcome_unknown`. Same-operation-ID retries within the live result store must not repeat native work. Do not claim exactly-once execution across a host crash.
9. Native file operations remain on the required UI thread. Cancellation before execution may prevent a mutation; once a native save/open has started, do not report that a client timeout canceled it. Large-file execution may continue and be reconciled through operation status.

### Native transitions and transaction recovery

The boundary must also cover native UI save/saveAs/open/close/activation/Undo/Redo and document changes triggered from Python/C# or other plugins. Existing document trackers publish state after events and do not provide this protection.

- Add owner-specific before/after event hooks where Rhino 8 supports them. Before a native transition, finish the bound editing segment while its document is still valid. Distinguish events generated inside Hopper's managed transition from external events to avoid recursive/double completion.
- If a pre-event is unavailable or the document already changed/disposed, invalidate the old segment and abandon its snapshot without applying it. Add an explicit abandon operation; GH `CancelActive()` is not suitable because it restores the old canvas. Preserve current native/user state and report loss of turn-level undo grouping when it cannot be retained safely. Apply the same rule to persistent user edits outside a managed mutation scope so later cancellation cannot erase them.
- Track backend transaction ownership as `{documentId, segmentId, epoch, state}`. Every targeted edit validates its document and segment at execution. A queued mutation cannot inherit an owner-wide boolean from an earlier active document. Native transitions advance epochs, including transitions triggered without a document tool.
- Replace Node's owner-only transaction booleans with observed segment metadata plus an `unknown` state. The authoritative backend returns current segment metadata in mutation results and a query supports reconciliation. Advisory events are hints, not the only recovery mechanism.
- After a transition timeout/lost reply, mark the affected transaction ownership unknown and block dependent edits and snapshot rollback until result/segment reconciliation succeeds. Do not use `runTransactionControl`'s current swallowed exceptions as evidence that commit/cancel succeeded. If the lifecycle ended, discard stale local ownership and never issue cancellation against a new document under the old segment ID.
- An RPC transition preflights target/policy/busy state, finishes the known segments, then runs native work under one dispatcher callback. Propagate boundary completion failures with side-effect metadata. If native callbacks reenter during the operation, validate owner/epoch again and reject further dependent work rather than assuming dispatcher ordering also excludes UI activity.
- Native event ordering and close-last behavior are release gates. Where a platform cannot implement an action without closing the application or risking stale snapshot restoration, advertise that action as unsupported and leave the document intact. Do not label the full cross-platform lifecycle feature complete until those gaps are resolved.

## Implementation sequence

1. **SDK spike and fixtures.** Compile tiny adapters against the pinned Rhino 8 packages, then exercise open/activate/close-last/saveAs and GH save/dirty-state behavior on disposable files. Record the macOS/Windows behavior matrix. Resolve the non-dialog close and Windows replacement paths before building tool wrappers.
2. **Contracts and document identity.** Add DTOs, handles, state tokens, capabilities, domain errors, inventories, and tests for no-document routing and stale targets. Add read tools so the agent can inspect targets.
3. **Transition coordinator.** Implement commit-and-transition ordering, transaction flag reconciliation, native UI dispatch, and fault handling. Extend runtime ownership/readiness tests and Core router tests.
4. **Rhino operations.** Implement new/open/activate/save/saveAs/close with native writers, explicit unsaved policy, and file conflict checks.
5. **GH operations.** Implement the same actions with document-server registration, canvas activation, and full serialization round trips.
6. **Agent integration.** Add tools to the catalog, progressive search keywords, schemas and schema UI. Update README and `mds/skills/rhino-document/SKILL.md`, GH workflow docs, and prompt routing. Route file work to document tools while keeping ordinary command execution available.
7. **Release verification.** Run focused tests, cross-language validation, production builds, and native smoke tests on both supported platforms. Record any unavailable native validation explicitly.

Likely new files: `src/tools/rh-document.ts`, `src/tools/gh-document.ts`, `src/services/document-management.ts`, `src/types/document-management.ts`, `dotnet/Hopper.Core/Operations/DocumentContracts.cs`, and native `Operations/DocumentOperations.cs` in each owner project. Existing changes center on the files linked above and the protocol v2 artifacts.

## Acceptance and verification

- Open/new with no Rhino model or GH canvas document; GH unloaded, unavailable, and loaded-with-no-document cases.
- Edit then save then edit again in one agent turn. Canceling later work does not revert the saved GH definition or cross into another document. Undo records remain attached to the correct documents.
- Two same-named documents, externally changed active selection, stale handles, lifecycle restart, and reopening the same path.
- Saved and unnamed dirty documents under every unsaved policy. Failed pre-close save leaves the target open with its changes.
- SaveAs preserves geometry/layers/materials for Rhino and scripts/wires/persistent data for GH. Reload disposable artifacts to verify contents and current path. Cover `.gh` and `.ghx`.
- Paths with spaces, quotes, Unicode, case differences, missing parents, read-only files, file locks, overwrite conflicts, and external modifications.
- Open the same file twice without duplicates. Close active and inactive documents, then close the final document and issue another open. Rhino stays running.
- Save/open reply loss, queued cancellation, native failure, and uncertain outcome do not trigger a duplicate mutation or a fabricated rollback.
- Existing GH graph tools, Rhino one-off scripts, lazy loading, and progressive discovery still work after document transitions.
- Observe A, edit A again without changing the active handle, then attempt open B/new with the old discard token. Reject before saving, closing, or replacing A. Cover initially clean and already-dirty A.
- SaveAs A to the path of active/inactive B and to a symlink/case alias of B. Reject regardless of the overwrite flag.
- During an agent turn, manually save GH through the UI and then cancel the turn. Never restore the definition from before that save. Repeat with UI saveAs, document activation/close, Undo/Redo, external persistent edits, and lifecycle changes made inside a script.
- Lose the transition reply after native completion, then attempt edit/cancel. Reconcile transaction epochs first; no old snapshot is applied to any document. Cover failure to commit and partial pre-save-success/close-failure results.
- Modify inactive documents, already-dirty objects/layers, and GH wires/script source with its solver disabled. Verify state tokens change for persisted edits and do not churn for an unchanged repeated solution.
- Browse a directory with mixed native files/subdirectories, Unicode paths, denied entries, and pagination with GH unloaded and no active model. No GH startup or file contents are needed.

Run focused Vitest suites during implementation, then `pnpm test`, `pnpm build`, `pnpm test:rpc-cross-language`, `dotnet test dotnet/Hopper.Core.Tests/Hopper.Core.Tests.csproj`, `dotnet test grasshopper-plugin.Tests/grasshopper-plugin.Tests.csproj`, and `pnpm build:gh-plugin`. Native Rhino 8 smoke tests are additional requirements, not covered by fake executors.

## Scope and related work

File browsing UI, project bundles, automatic Rhino/GH pairing, import/export of foreign formats, autosave scheduling, and changes to the RhinoScript editor are later work. The initial tools still provide full native document lifecycle management.

The independent plan in branch `plan/rhino-virtual-scripts`, `docs/rhino-virtual-scripts-plan.md`, adds editable script assets. Both features can ship independently. Coordinate document-handle contracts and execution preconditions when merging; neither feature should create a second document registry.

## API evidence

- [RhinoDoc.Open](https://developer.rhino3d.com/api/rhinocommon/rhino.rhinodoc/open) documents platform-specific opening behavior.
- [RhinoDoc.WriteFile](https://developer.rhino3d.com/api/RhinoCommon/html/M_Rhino_RhinoDoc_WriteFile.htm) documents naming, backup, and file-lock handling.
- [Rhino 8 document API](https://developer.rhino3d.com/api/rhinocommon/rhino.rhinodoc?version=8.x) is the starting point for the native spike.
- [GH_DocumentIO](https://developer.rhino3d.com/api/grasshopper/html/Methods_T_Grasshopper_Kernel_GH_DocumentIO.htm) exposes path-based open/save methods.
- [GH_DocumentServer.SafeRemoveDocument](https://developer.rhino3d.com/api/grasshopper/html/M_Grasshopper_Kernel_GH_DocumentServer_SafeRemoveDocument.htm) documents UI prompts on unsaved data; it is not automatically an unattended close solution.

Online GH API pages currently describe newer builds. Verify every selected method against the pinned Rhino 8 assemblies. No native smoke test was performed while writing this plan.

## Adversarial review disposition

The 2026-09-06 subagent review found missing affected-document revision checks, external UI transaction boundaries, SaveAs live-document collisions, and event coverage for state tokens. The contract, recovery policy, and acceptance cases above now specify those requirements. Local review also added usable path discovery, explicit partial-effect results, and transaction-epoch reconciliation after reply loss. These are plan corrections, not verified runtime fixes. Native event ordering, state-token coverage, and platform lifecycle behavior remain implementation release gates.
