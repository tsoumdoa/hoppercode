# Rhino Document Scripting (rh_run_script)

Use this for **Rhino document** work via `rh_run_script`. For a new Grasshopper script component use `gh_apply_graph.scripts`; for an existing component use `gh_edit_script` and [python-boilerplate.md](./python-boilerplate.md) / [csharp-boilerplate.md](./csharp-boilerplate.md).

## Modes

| mode | When to use |
|------|-------------|
| `command` | Short Rhino macros: `_Circle 0,0,0 5`, `_SelLayer`, `-Layer Current "Default"` |
| `python` | Multi-step geometry, loops, `rhinoscriptsyntax` (Rhino 8 RhinoCode / Python 3) |
| `csharp` | Rhino C# script editor body (Rhino 8 RhinoCode) |

Python and C# both run through **RhinoCode** (`Rhino.Runtime.Code`) in Rhino 8. Hopper prepends the language shebang if you omit it (`#! python 3` / `// #! csharp`).

## Python pattern

```python
import rhinoscriptsyntax as rs
import scriptcontext as sc

doc = sc.doc
ids = rs.AddCircle((0, 0, 0), 5.0)
print(ids)
```

- Use `scriptcontext.doc` for the active document.
- Use `print()` for values the agent should read in the tool result.

### Listing / counting objects

Rhino 8 **does not** support `doc.Objects.GetObjectList()` with zero arguments. Prefer:

- **`rh_query_objects`** from the agent (short IDs, filters, `countOnly`) — best for Hopper workflows.
- **RhinoCommon:** `doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject)` or iterate `for obj in doc.Objects:`.
- **rhinoscriptsyntax:** `rs.ObjectsByType(rs.filter.allobjects)` — not raw `GetObjectList()`.

```python
import rhinoscriptsyntax as rs
import scriptcontext as sc
import Rhino

doc = sc.doc
count = len(rs.ObjectsByType(rs.filter.allobjects))
print(f"Total objects in doc: {count}")
```

## C# pattern

```csharp
using Rhino;
using Rhino.Geometry;

var doc = RhinoDoc.ActiveDoc;
var id = doc.Objects.AddCircle(new Circle(Point3d.Origin, 5.0));
doc.Views.Redraw();
Console.WriteLine(id);
```

- Write the **script editor body** only (no class wrapper). Hopper adds `// #! csharp` when missing.
- Use `Console.WriteLine(...)` the same way Python uses `print(...)` — both are captured in the tool result.
- Prefer `RhinoDoc.ActiveDoc` (or geometry APIs that accept `doc`) for document work.

## Command pattern

- Prefix suppressed commands with `_` (e.g. `_Circle`).
- Chain with spaces or newlines as in the Rhino command line.

## Undo

When Hopper Pi lifecycle hooks run, all `rh_run_script` calls in one agent turn are grouped into **one Rhino Undo** step (separate from Grasshopper canvas undo).

## Do not use rh_run_script for

- Adding GH components, wires, sliders → `gh_*` tools
- Creating a GH Python/C# **script node** in a new graph → `gh_apply_graph.scripts`
- Editing an existing GH Python/C# **script node** → `gh_edit_script`

## Saved source and fine-grained editing

Create a named asset with `rh_script`:

```json
{"action":"create","name":"Circle study","language":"python","source":"import rhinoscriptsyntax as rs\nprint(rs.AddCircle((0, 0, 0), 5.0))\n"}
```

Keep its returned `scriptId`, `workspaceId`, and revision. Change the radius with a patch against revision 1:

```json
{"action":"patch","scriptId":"<returned ID>","expectedRevision":1,"patches":[{"action":"replace","startLine":2,"endLine":2,"lines":["print(rs.AddCircle((0, 0, 0), 8.0))"],"expectedText":"print(rs.AddCircle((0, 0, 0), 5.0))"}]}
```

Call `rh_script.getExecutionTarget` to inspect units, tolerances, and document identity. Pass its `document` object unchanged as `expectedDocument`:

```json
{"items":[{"scriptId":"<returned ID>","revision":2,"expectedDocument":{"documentId":"<returned document ID>","lifecycleInstanceId":"<returned lifecycle>","settingsRevision":"<returned settings revision>"}}]}
```

Only `rh_run_script` executes source. Running this revision twice can add two circles. Python and C# assets use full source without Grasshopper's `RunScript` scope. Use `gh_edit_script` for code inside a Grasshopper component.

`rh_script.get` returns at most 200 numbered lines and 16,000 source characters. Check `truncated` and `nextLine`. A long individual line is returned as `partialLine` with explicit truncation. Continue that same line with `characterOffset: partialLine.nextCharacterOffset` until the offset is null. Diffs have a 12,000-character cap. All source is normalized to LF; a final newline is preserved, and an empty source has zero lines. Read-only actions and history remain available after soft deletion. `restore` copies historical source into a new head revision; `undelete` makes a deleted asset runnable again.

Source and run journals live under `<scriptWorkspaceDir>/.hopper/rhino-scripts`. Embedded hosts default to `<dataDir>/workspaces/default`, independent of the Rhino lifecycle ID. Set an absolute `--script-workspace` or `HOPPER_SCRIPT_WORKSPACE` to choose another folder. CLI extensions default to the selected project directory. The default quota is 64 MiB, including reserved run completion capacity. Raise `--script-workspace-quota-bytes` or `HOPPER_SCRIPT_WORKSPACE_QUOTA_BYTES` when `WORKSPACE_LIMIT_REACHED` reports the storage path and usage. Saving a CAD document does not move these assets.

Writer locks are held only during short synchronous storage transactions. A live writer returns `WORKSPACE_BUSY`; retry the same mutation identity after it completes. An unreadable lock or interrupted recovery lock requires inspecting the lock and confirming all workspace writers have stopped before manual removal. History is never purged automatically. Retained runs include bounded output, operation IDs, and the source revision. Native diagnostics remain raw unless a reliable source location is supplied; do not infer user-source line numbers from library stack frames.
