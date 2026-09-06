# Rhino and Grasshopper document management

Implemented on `plan/document-file-management` and combined with script editing on `feat/document-script-integration`. The original 2026-09-06 plan remains in Git history.

The agent uses `rh_document` and `gh_document` to list, inspect, create, open, activate, save, saveAs, and close native `.3dm`, `.gh`, and `.ghx` documents. Both tools also browse native file paths and inspect units and tolerances.

The implementation contract and platform behavior are maintained in [document management implementation](document-management-implementation.md). Test results and reproduction commands are maintained in [integration verification](document-script-integration-verification.md).

## Decisions retained

- Native lifecycle operations use exact live document handles and fresh observed state. New/open/activate check the active handle; replacement and close require explicit unsaved policies. A save failure prevents the dependent close or replacement.
- File operations finish editing segments. Saving files is separate from geometry or canvas Undo. Responses preserve completed effects and report uncertain outcomes without inviting automatic replay.
- Paths are absolute on the Rhino machine. SaveAs checks external file changes, canonical destination ownership, and explicit overwrite/directory creation options.
- Settings inspection is read-only and separate from file mutation. Model and layout units remain distinct. Grasshopper reports its associated Rhino document, active context, and any mismatch.
- Core owns shared policy and DTOs; each native adapter owns its application APIs. Mac window registration can be pending, which blocks dependent mutations until the exact document resolves.

## Remaining scope

Windows runtime replacement/close, close-last behavior, full native event coverage, custom units/layout combinations, file locking, missing-component warnings, and concurrent external writers need the platform tests listed in the implementation record. Compilation alone does not establish native behavior.

Settings editing, automatic geometry rescaling, import/export of other CAD formats, and autosave are outside this change.
