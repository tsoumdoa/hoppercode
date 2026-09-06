# Document management implementation

The `rh_document` and `gh_document` tools support native document inventory, settings inspection, directory browsing, new/open/activate/save/saveAs/close. Each tool performs one lifecycle action. Rhino script calls can bind execution to a specific document and settings revision through `expectedDocument`.

The implementation compiles against RhinoCommon and Grasshopper `8.0.23304.9001` for `net7.0` and `net7.0-windows`. The platform branches use the pinned APIs below. Runtime verification on each platform remains separate from compilation.

| Operation | Rhino | Grasshopper |
| --- | --- | --- |
| New | `RhinoDoc.Create`, standard views when needed, explicit activation | New `GH_Document`, register with document server, activate canvas |
| Open | `RhinoDoc.Open`, exact canonical path reuse | `GH_DocumentIO.Open`, register once, activate canvas |
| Save and SaveAs | `RhinoDoc.WriteFile` with path updates, user data, suppressed dialogs/input | `GH_DocumentIO.SaveQuiet`, update live path and modified flag only after success |
| Close | macOS document-bound `_-Close`; Windows blank-document replacement | Select remaining canvas, `RemoveDocument`, dispose removed definition |
| Settings | Model/page units, custom scale, tolerances and precision from target RhinoDoc | Associated Rhino identity and active Rhino source, with source snapshot and mismatch reporting |

Rhino's pinned `Open` API replaces the active model on Windows and opens another model window on macOS. Windows replacement requires an explicit policy and state token for the affected model. Validated discard suppresses the old modified flag only for the replacement call and restores it if replacement fails. Windows close retains the application by creating a blank replacement. This Windows behavior requires native Windows validation before release.

A missing parent directory is created only with `createDirectories: true`, after document and overwrite policy checks. `templatePath` creates an unnamed document. The agent must use `saveAs` for unnamed documents.

## Identity, files, and state

A document handle contains the host lifecycle identity, owner, and a live native identity. Rhino uses its runtime serial number. Grasshopper uses a service-issued handle per live document instance, so reopening the same serialized GH DocumentID does not revive an old handle. No operation resolves by name.

Canonical paths resolve symlinks in every existing ancestor and use filesystem-observed casing. This preserves distinct files on case-sensitive APFS while recognizing casing aliases on default APFS. SaveAs refuses a destination owned by another live document, even with overwrite enabled. Existing backing files have a SHA-256 baseline; a replaced file with unchanged size and timestamps still conflicts. Native save notifications refresh that baseline.

External-writer exclusion is limited by the filesystem and native writer. Digest checks immediately before writing do not provide atomic compare-and-swap against unrelated writers. Native write failure reports the attempted path and uncertain stage, so callers can inspect the retained operation result instead of replaying the whole action.

Rhino tokens combine live identity, path, dirty state, settings, and observed revisions. Subscriptions cover object add/delete/replace/undelete/attributes, layers, materials, linetypes, dimensions, instance definitions, groups, lights, render content, texture mappings, document properties, and document user strings. Settings revisions are derived from the exact current settings snapshot. Grasshopper tokens fingerprint the full serialized definition, including scripts, wires, persistent data, and component state. Serialization failure rejects inspection/destructive policy with `STATE_VALIDATION_UNAVAILABLE`.

The full Rhino event-coverage matrix, including third-party custom data and all Undo/Redo cases, still needs native coverage tests. The token is an optimistic observation check, not an atomic exclusion of other plugins or user activity during native callbacks.

## Editing segments

Document mutations finish the editing segment in the same ordered backend dispatch as the native lifecycle operation. The Node runtime serializes mutations for each owner, reconciles `{documentId, segmentId, epoch, state, lifecycleInstanceId}`, and sends the expected segment with later edits. File writes never join the geometry/canvas undo transaction.

Rhino's native save/open/close/activation/Undo/Redo callbacks finish or abandon old grouping. Grasshopper records its last agent snapshot and abandons rollback when native state, active definition, backing path, or external save changes. Commit/cancel callbacks run under a guard so their own native undo events cannot recursively abandon an in-progress completion. Handlers detach on service disposal and document removal.

A lost mutation response blocks dependent edits and cancellation until retained operation lookup returns a terminal result and the native segment query succeeds. A host restart invalidates the old lifecycle. There is no exactly-once guarantee across a host crash.

## Settings interpretation

`getSettings` never activates another document, modifies a file, or runs a Grasshopper solution. Model and layout units remain separate. Relative tolerance is the native dimensionless ratio; the Properties UI displays ratio multiplied by 100 as a percentage. Angle tolerance includes explicitly labeled radians and degrees. Display precision does not replace computational tolerance.

Unitless or unavailable conversions return no meters-per-unit conversion. Grasshopper reports unresolved context when no Rhino source exists. Standard helper context is identified as active Rhino; individual components and explicit inputs can use different tolerances.

For a 2-meter request in a millimeter model, geometry receives 2000 model units. Counts and other dimensionless inputs are unchanged. The tools inspect settings; they do not change units or loosen tolerances to make geometry operations succeed.

## Verification

- TypeScript compilation and the complete Vitest suite passed, including document validation, discovery, readiness, segment boundaries, and uncertain-result reconciliation.
- Cross-language RPC smoke tests passed with the added operations.
- Core tests cover stale dirty replacement, live SaveAs collisions and symlink aliases, same-size external replacement, partial pre-save success with close failure, native-save baseline refresh, parent creation, and bounded browsing.
- Both native production projects build for their pinned macOS-compatible and Windows target frameworks.
- `DocumentManagementNativeTests.RunAll` is an explicit native smoke entry point. It uses disposable documents; it is not an automatically executed xUnit test.
- Two existing graph contract tests cannot load Grasshopper in the ordinary standalone dotnet test host. They require the installed Rhino runtime.

Record actual native smoke results alongside this document before release. Windows close/replacement, close-last behavior, full event ordering, custom-unit and layout combinations, file locks, missing-component load warnings, and concurrent external writers need native platform testing beyond fake-executor tests.
