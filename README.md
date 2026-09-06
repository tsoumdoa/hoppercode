# hoppercode

A transparent, hackable modeling agent for computational designers who want
AI inside their real workflow — not locked behind a black-box SaaS.

> **Heads up:** This project was heavily vibe-coded and is super early in its own development. APIs, tools, and behavior will change without notice. **Use it at your own risk.**

**hoppercode** (published as [`hopper-pi`](https://www.npmjs.com/package/hopper-pi)) can run in two ways: as a normal Pi extension, or as a private Rhino-owned agent with a browser UI. Both use the same ZeroMQ backend to inspect and edit Grasshopper and Rhino.


## What's new

### Unreleased image attachments

The browser composer accepts PNG, JPEG, WebP, and GIF files through the image button, drag and drop, or clipboard paste. Attach up to four images, each at most 5 MB. Use the thumbnail controls to replace or remove an attachment before sending.

Click an image to annotate it with Excalidraw. Add arrows, shapes, text, or freehand marks, then choose **Save annotations**. You can reopen and edit the marks while the image is in your draft. Sending exports the drawing as a PNG for the selected vision model; the conversation retains that image after reconnecting. Draft images and editable drawing data are kept in memory and are cleared by a page reload or a new session.

To sketch without an image, click **Draw** in the composer. This opens a blank Excalidraw canvas with the freehand tool selected. Choose **Save drawing** to attach it as a PNG; click its thumbnail to continue editing before sending. Drawings share the four-attachment limit with uploaded images.

Use **Image opacity** below the editor to fade the source image from 100% to 0% while keeping your annotations visible. The setting is included in the saved PNG and restored when you reopen the draft's annotations.

Oversized annotation exports are reduced in resolution to fit the 5 MB attachment limit. The editable drawing retains its original scene data. Draft text, images, and annotations stay in the composer until the host accepts the message; rejected or interrupted submissions remain available to retry.

The editor loads on demand. Its fonts are included in the web build and served by the local host. Excalidraw adds about 13 MB of font assets plus its JavaScript bundles to the packaged UI.

### Unreleased — Direct viewport capture

- **No screenshot permission prompt:** `rh_capture_view` can capture the Rhino viewport as soon as a multimodal model requests it. The per-session consent prompt and its environment override have been removed.

### 0.1.90 — Slim progressive tool catalog

- **Opt-in progressive tools:** start with a small always-on Hopper core and activate specialists on demand. Enable with `HOPPER_PROGRESSIVE_TOOLS=1` or `--hopper-progressive-tools`. Off by default, so the current all-tools-active behavior stays.
- **`hopper_search_tools`:** keyword search over the typed Hopper catalog; matching specialists activate for the rest of the session and reset on new/reload sessions.
- **Catalog + size diagnostics:** tools carry group, keywords, and core flags. `/hopper-schemas sizes` reports compact schema bytes by group and tool. Discoverable tools omit prompt snippets so the active set stays lean.

### 0.1.80 — Atomic graph apply & tool schema browser

- **`gh_apply_graph`:** create a complete new Grasshopper subgraph in one synchronous call — components, widgets, scripts, wires, and groups — then run one solution and return short IDs plus runtime/overlap validation. New builds default to one apply; legacy edit tools stay for surgical repair.
- **`/hopper-schemas`:** browse the exact agent-facing JSON schemas (name, description, parameters, guidelines) for every registered tool; `/hopper-schemas dump` writes `tool-schemas.json` in the cwd.
- **Anthropic schema fix:** `gh_apply_graph` wire endpoints now emit draft 2020-12 `prefixItems` tuples so Claude no longer rejects the tool `input_schema`.
- **Skill guidance:** modeling/cookbook/Rhino skills and reference docs point at the apply-once workflow; trim stale “core principles” from `gh-modeling-expert`.
- **Prompt examples:** add pavilion / attractor plan prompts under `prompt-examples/`.

### 0.1.70 — Faster agent guidance & screenshot override

- **Less overthinking in Grasshopper/Rhino skills:** tighten clarification rules so the agent proceeds with documented defaults unless ambiguity materially changes output, risks data loss, or could edit the wrong target.
- **Faster Grasshopper build guidance:** make “read once” a new-build default rather than a hard rule, remove verbose Tier 3 placement-math narration, allow confident multi-zone batching, and scope cleanup to touched components only.
- **Screenshot permission override:** `HOPPER_RHINO_CAPTURE_CONSENT=allow` pre-allows Rhino viewport screenshots for restricted or non-interactive UI sessions; `deny` forces capture off. Users can also explicitly ask to allow screenshots later in a session.
- **Tool schema cleanup:** `gh_list_components.searchFrom` now matches its documented default, and `gh_edit_components` uses action-specific required fields so agents can make shorter, more reliable tool calls.
- **Package cleanup:** remove stale Pi skill/prompt paths that pointed at missing directories.

### 0.1.6 — Undo history fix & security hardening

- **Fix: Rhino undo history (#16)** — nested agent undo records broke Rhino's undo stack. Per-script `RecordDocumentUndo` is now disabled during agent turns so the single `RhinoAgentTransaction` owns the undo record, and `Cancel` no longer calls `doc.Undo()` (which could wipe unrelated user edits).
- **Security hardening:** compare the ZMQ auth token in constant time, restrict the connection-profile token file to owner-only (`0600`), sanitize the view name interpolated into Rhino macros, and stop leaking stack traces to the wire.
- **Reliability:** dispose the `JobQueue` signal and stop fire-and-forget shutdown waits, widen `formatMetadata` to accept null, and tighten plugin visibility (`public` → `internal`).
- **CI/build:** add a GitHub Actions workflow for TypeScript typecheck and tests, bump to pnpm 11.5.3 / Node 22, disable credential persistence in checkout, and drop an unused `roslyn-language-server.linux-arm64` dependency.

### 0.1.5 — View capture & control

- **`rh_capture_view`** — capture a Rhino viewport screenshot as PNG visual context for visual QA, composition, visibility, and display checks. Permission-gated: only active after you allow Rhino viewport screenshots for the session, and only on models that accept image input.
- **`rh_view_control`** — drive the viewport: switch active / standard / named / CPlane views, set the camera (location, target, lens length, projection), zoom (extents / selected / bounding box), and save named views.
- New per-session viewport-capture consent flow so screenshots are opt-in.

### 0.1.4 — Agent can ask questions

- **`ask_user`** — ask the user a free-text clarifying question and wait for an answer when requirements are ambiguous.
- **`pick_option`** — present 2–6 informed options to pick from (e.g. resolving ambiguous component matches after `gh_list_components`). An "Other" choice is appended automatically.
- Fixes: silent failures on certain operations, long GUIDs leaking into output, and license corrections.

## What you need

- **Rhino 8** on macOS arm64 or Windows x64
- A stable **Node.js 22.19.0 or newer** installation
- **.NET 7 SDK** and pnpm 11.5.3 only when building Hopper from source
- **[Pi](https://github.com/earendil-works/pi)** only for the external extension workflow

## Quick start

### Rhino browser host

Hopper's Yak packages contain the Rhino plug-ins, private browser host, Pi SDK dependencies, and web UI. They do not contain Node. Install a stable Node release at or above 22.19.0 and check it before installing Hopper:

```text
node --version
```

Prerelease Node versions are not supported. Hopper runs Node directly and never invokes a global Pi CLI.

#### macOS arm64

```bash
git clone https://github.com/tsoumdoa/hoppercode.git
cd hoppercode
./scripts/install-rhino-mac.sh --open-rhino
```

Quit Rhino before running the script. It builds and verifies the `mac-arm64` package, creates the Yak archive, and installs it with Rhino 8's Yak executable. If `hopper-pi` is installed, the script asks before replacing it.

#### Windows x64

Run these commands in PowerShell with Rhino closed:

```powershell
git clone https://github.com/tsoumdoa/hoppercode.git
cd hoppercode
corepack enable
pnpm install --frozen-lockfile
pnpm package:rhino -- --target win-x64 --yak
$version = node -p "require('./package.json').version"
$source = Join-Path $PWD "artifacts\hopper-pi-$version-win-x64"
& "$env:ProgramFiles\Rhino 8\System\Yak.exe" install "--source=$source" hopper-pi $version
```

The package command verifies the staged files before Yak installation. Set `HOPPER_YAK` to the absolute Yak executable path if Rhino is installed elsewhere.

To build a target without creating a `.yak`, omit `--yak`:

```bash
HOPPER_SKIP_GH_PLUGIN=1 pnpm install
pnpm package:rhino -- --target mac-arm64
```

Restart Rhino after installation, then run:

```text
HopperCode
```

Rhino starts one private loopback host, completes an authenticated handshake for that Rhino instance, and opens its tokenized localhost URL. Provider login, model choice, conversations, extension dialogs, and tool progress stay in that browser tab.

If you close the browser tab, run `HopperCode` again in the same Rhino instance to reopen it with the current conversation. Closing the tab leaves the host and any active response running. The reopened UI restores the conversation and current progress. If another Hopper tab is still open, the new tab takes over the connection.

Open **Skills & Markdown** in the sidebar to inspect the bundled skills, preview their Markdown and reference files, or turn individual skills off. Enabled skills appear in the agent's skill catalog; the agent can load relevant files with a restricted `read` tool. This tool only reads enabled Markdown in this library. Pi's general shell, edit, and write tools remain disabled.

To add your own instructions:

1. Copy the **Your Markdown folder** path from the panel and open it in Finder or File Explorer.
2. Save or drop `.md` files there. Plain Markdown works; the filename becomes the skill name and the first non-empty line becomes its description.
3. The panel refreshes every three seconds while Hopper is idle. The host also scans before a new prompt, so the panel does not need to stay open.

For instructions with references, create a folder containing `SKILL.md` and related Markdown files. Optional YAML frontmatter sets the name and description:

```markdown
---
name: office-modeling
description: Office standards for architectural models, units, and layer names.
---

# Office modeling standards
Use meters. Follow the layer names in [layers.md](./layers.md).
```

Markdown under a `SKILL.md` folder belongs to that skill and is disabled with it. Other Markdown files, including those in subfolders, are listed individually. Symbolic links and non-Markdown files are skipped. Each file is limited to 256 KiB, with up to 500 Markdown files in the library. Discovery errors appear in the panel.

The default drop folder is `<host data directory>/skills`. On macOS this is `~/Library/Application Support/hopper-pi/host/skills`; on Windows it is `%APPDATA%/hopper-pi/host/skills`. To use an existing folder elsewhere, enter its absolute path in the panel and choose **Use folder**. Paths beginning with `~/` also work. Keep this folder separate from the bundled skill directories.

The host saves the folder and disabled skill IDs in `<host data directory>/skills-settings.json`, shared by Hopper windows using that data directory. If multiple windows save settings simultaneously, the last save wins. Changes apply at the next idle refresh or prompt, and controls are disabled while a turn is running. Disabling a skill removes it from discovery and prevents further reads through `read`; it does not remove text already in conversation history. Start a new session for a clean context. The read restriction applies to this file-reading tool, not to scripts executed inside Rhino.

Skill choices survive restarts. Skills are enabled unless their ID appears in the saved `disabled` list; turning one back on removes its ID. The model picker saves the selected provider and model as `defaultProvider` and `defaultModel` in `<host data directory>/agent/settings.json`. New sessions use that selection when its provider is authenticated and the model is available. Resuming an existing conversation restores that conversation's model first.

On Windows, press **Win+R**, enter `%APPDATA%\hopper-pi\host`, and press Enter. This normally opens `C:\Users\<username>\AppData\Roaming\hopper-pi\host`:

| Relative path | Saved content |
| --- | --- |
| `skills\` | Custom Markdown files, unless you chose another folder |
| `skills-settings.json` | Custom folder path and disabled skill IDs |
| `agent\settings.json` | Last selected provider/model and Pi preferences |

On macOS, these files are under `~/Library/Application Support/hopper-pi/host`. A host launched with `--data-dir` uses that directory instead. Changing the custom Markdown folder does not move the settings files.

The Rhino commands are:

| Command | Behavior |
| ------- | -------- |
| `HopperCode` | Start Hopper from `stopped` or `faulted`. When `running`, reopen the browser with the current conversation. In other states, print the current state. |
| `HopperCodeStatus` | Print lifecycle, Node, transport, document, Grasshopper, dispatcher, and recent error details without starting Hopper. |
| `HopperCodeStop` | Stop the current host and transport in the background. |
| `HopperCodeRestart` | Finish stopping the current instance, then start one replacement. Repeated restart requests are coalesced. |

`HopperCode` does not load Grasshopper. The first `gh_*` tool call starts it once and waits up to 60 seconds for readiness. Rhino may open the Grasshopper editor and create an untitled definition during that explicit tool call. Grasshopper tools require an active definition, while `rh_*` tools continue to work without one.

### Choosing Node

Hopper resolves Node in this order:

1. The absolute path in `HOPPER_NODE_EXECUTABLE`.
2. `nodeExecutable` in Hopper's app-data `config.json`.
3. `node` from the Rhino process `PATH`.
4. Standard installation paths.

The standard macOS paths are `/opt/homebrew/bin/node`, `/usr/local/bin/node`, and `/usr/bin/node`. On Windows, Hopper checks `%ProgramFiles%\nodejs\node.exe` and `%LocalAppData%\Programs\nodejs\node.exe`.

Rhino launched from Finder or the Windows desktop may have a different `PATH` than your terminal. For nvm, fnm, Volta, asdf, mise, or a custom Node install, set an absolute path in:

- macOS: `~/Library/Application Support/hopper-pi/config.json`
- Windows: `%APPDATA%\hopper-pi\config.json`

macOS example:

```json
{
  "nodeExecutable": "/Users/you/.nvm/versions/node/v22.19.0/bin/node"
}
```

Windows example:

```json
{
  "nodeExecutable": "C:\\Program Files\\nodejs\\node.exe"
}
```

The configured file must exist and be executable. Hopper runs `node --version` with a three-second timeout and rejects malformed, prerelease, or older versions. `HopperCodeStatus` prints the resolved path, version, or exact resolution error.

### External Pi extension workflow

```bash
pi install npm:hopper-pi
```

`postinstall` builds the C# plug-ins and copies them into your Grasshopper libraries folder.

1. Restart Rhino and run `HopperCode` to start the Rhino-owned runtime.
2. Start Pi and talk to the agent about Grasshopper or Rhino. The extension registers `gh_*` and `rh_*` tools automatically.

The GHZMQ component preserves old definitions, but it does not start the transport or Node. No canvas component is required for Hopper.

### Clone and develop

```bash
git clone https://github.com/tsoumdoa/hoppercode.git
cd hoppercode
pnpm install          # builds & installs the GH plugin unless skipped
pnpm run pi           # run Pi with this extension loaded
```

Skip the plugin build when iterating on TypeScript only:

```bash
export HOPPER_SKIP_GH_PLUGIN=1
pnpm install
pnpm run dev
```

### Test the browser UI without Rhino

```bash
pnpm ui:mock
```

Open http://localhost:5174. This runs the Vite UI against local fixture data, so it never starts Rhino or contacts a provider account. Send a normal prompt to exercise streaming and tool-call rendering. The following prompts open representative interactive and error states: `/mock option`, `/mock confirm`, `/mock editor`, and `/mock failure`.

### Develop the browser UI against Hopper

Run `pnpm host:dev` with the Rhino backend active, then run `pnpm ui:dev` in a second terminal. The host prints a JSON object whose `url` ends with the session token. Open `http://localhost:5173/` with that same fragment, for example `http://localhost:5173/#TOKEN`.

Rebuild or reinstall the plugin manually:

```bash
pnpm run build:gh-plugin
# or force a full rebuild + copy:
node scripts/install-grasshopper-plugin.mjs --force
```

## Architecture

```
Browser UI  ⇄  private Hopper host + embedded Pi SDK  ⇄  authenticated ZMQ  ⇄  Rhino
                         ↑                                      ↑
                  exact local package                  Rhino-owned runtime status
```

- `Hopper.Rhino.rhp` provides the four `HopperCode` commands and connects Rhino lifecycle services to the host process, browser launch, health checks, and shutdown policy.
- `Hopper.Core.dll` contains the Rhino-free protocol and lifecycle policies.
- `Hopper.Grasshopper.gha` registers Grasshopper operations only after Grasshopper loads. It preserves the existing GHZMQ component identity for old definitions.
- The host binds only `127.0.0.1`, checks the browser origin, and requires a 256-bit token as the first WebSocket message. The token begins in the URL fragment and is removed from browser history.
- Provider credentials use the global Pi auth file at `~/.pi/agent/auth.json` by default, including `PI_CODING_AGENT_DIR` overrides. Login, token refresh, and logout in Hopper update that shared file. Model settings remain in Hopper's private user-data directory. Session and workspace state are separated per live Rhino backend instance.

The RPC socket uses ROUTER and DEALER framing, authenticates every request, and correlates replies by request ID. The loopback PUB/SUB socket carries advisory status wakeups. Node always rereads Rhino's full status after a wakeup. Treat the workstation account as the confidentiality boundary and do not expose these endpoints beyond loopback.

Rhino binds free loopback endpoints and writes them with a local connection token to an instance-specific profile. It also updates `connection.json` as a best-effort pointer to the last-started instance:

- Windows: `%APPDATA%\hopper-pi\connection.json`
- macOS: `~/Library/Application Support/hopper-pi/connection.json`

Each Rhino-owned host also writes an authoritative instance profile under `hopper-pi/runtime/profiles/<lifecycle-instance-id>.json` and passes that exact path to its Node child, so concurrent Rhino processes do not depend on the last-writer-wins compatibility pointer. On later launches, Hopper deletes profiles only after verifying that the recorded PID and process start time no longer identify a live owner; malformed or uninspectable profiles are retained. Ephemeral logs use the sibling `<lifecycle-instance-id>.logs/` directory and are eligible for deletion seven days after death is verified.
Override profile discovery with `HOPPER_CONNECTION_PROFILE` for development.

## Agent tools (overview)

**Rhino document**

| Tool | Role |
| ---- | ---- |
| `rh_run_script` | Rhino commands, Python, or C# on the active document |
| `rh_query_objects` | List/count objects (short IDs for GH params) |
| `rh_view_control` | Viewport, projection, camera, CPlane view, and zoom |
| `rh_capture_view` | Optional viewport screenshot for multimodal models |

**Grasshopper canvas — edit**

| Tool | Role |
| ---- | ---- |
| `gh_apply_graph` | Atomically create and validate a complete new subgraph |
| `gh_edit_components` | Surgical add, move, or delete operations |
| `gh_edit_param` | Inspect and edit GH script-component input/output ports |
| `gh_edit_wire` | Connect / disconnect wires |
| `gh_edit_group` | Groups |
| `gh_edit_script` | Script component source |
| `gh_create_widget` / `gh_mutate_widget` | Surgical widget creation or changes |
| `gh_param_rhino` | Reference or internalize Rhino geometry on params |

**Grasshopper canvas — query**

| Tool | Role |
| ---- | ---- |
| `gh_get_canvas` | Canvas layout and component snapshot |
| `gh_list_components` | Search component library by keyword |
| `gh_get_canvas_errors` | Runtime messages plus component-overlap checks |

**User clarification**

| Tool | Role |
| ---- | ---- |
| `pick_option` | Ask the user to choose among informed options |
| `ask_user` | Ask a free-text question when options are not practical |

**Progressive loading (opt-in)**

| Tool | Role |
| ---- | ---- |
| `hopper_search_tools` | Search the Hopper catalog and activate specialists (`HOPPER_PROGRESSIVE_TOOLS=1` / `--hopper-progressive-tools`) |

Bundled Pi skills and progressive reference docs live under `mds/` (`gh-modeling-expert`, `rhino-document`, `gh-cookbook`, and `gh-reference`).

For new Grasshopper builds, the canonical workflow is: resolve unusual or ambiguous types if needed, call `gh_apply_graph` once, inspect its integrated runtime/overlap validation, then use legacy tools only for surgical repair. `gh_get_canvas` remains for existing canvases, selections, and subgraphs.

## Repo layout

| Path | Role |
| ---- | ---- |
| `src/host/` | Embedded Pi runtime, loopback server, protocol, and browser UI |
| `src/` | Pi extension, ZMQ client, tools, and XML parsing |
| `dotnet/Hopper.Rhino/` | Rhino lifecycle plug-in and `HopperCode` commands |
| `dotnet/Hopper.Grasshopper/` | Lazy Grasshopper operation adapter and passive GHZMQ compatibility component |
| `dotnet/Hopper.Core/` | Rhino/Grasshopper-free protocol, lifecycle, dispatch, and transport policies |
| `scripts/package-rhino.mjs` | Stage and verify a `mac-arm64` or `win-x64` package |
| `docs/hopper-local-architecture.html` | Interactive architecture and implementation plan |
| `mds/` | Skills and progressive reference docs for the agent |

## Environment variables

| Variable | Effect |
| -------- | ------ |
| `HOPPER_SKIP_GH_PLUGIN=1` | Skip plugin build/install on `pnpm install` |
| `HOPPER_GH_LIBRARIES` | Override Grasshopper Libraries install path |
| `HOPPER_GH_PLUGIN_DIR` | Subfolder under Libraries (default: `hopper-pi`) |
| `HOPPER_GH_STRICT=1` | Fail install on build/copy errors (default: warn and continue) |
| `HOPPER_CONNECTION_PROFILE` | Connection profile path override |
| `HOPPER_PI_AUTH_PATH` | Override the auth file; defaults to the global Pi `auth.json` |
| `HOPPER_PROGRESSIVE_TOOLS=1` | Opt in to a small Hopper core + `hopper_search_tools` (specialists activate on demand). Off by default. Also `--hopper-progressive-tools`. |
| `HOPPER_YAK` | Absolute Yak path when `package:rhino -- --target mac-arm64 --yak` or `--target win-x64 --yak` cannot find Rhino 8 |
| `HOPPER_NODE_EXECUTABLE` | Absolute Node executable path; highest resolver priority |

## Troubleshooting

- **Inspect tool schemas:** Run `/hopper-schemas` to browse the JSON schemas exposed to the agent for every registered tool (or `/hopper-schemas rh_run_script` / `/hopper-schemas all`). Dump them with `/hopper-schemas dump` (writes `tool-schemas.json` in the cwd). `/hopper-schemas sizes` reports catalog counts and compact schema bytes by group/tool.
- **`HopperCode` is unknown:** Install the generated `.yak`, rather than copying only the `.gha` to Grasshopper Libraries, then restart Rhino. A Rhino `.rhp` must be loaded for the command to exist.
- **Browser tab closed:** Run `HopperCode` again in the same Rhino instance to reopen the current conversation.
- **Browser host does not open:** Run `HopperCodeStatus`. It reports lifecycle state, child PID, Node resolution, handshake health, and startup errors without printing the secret URL.
- **Node is missing or unsupported:** Run `node --version` in a terminal. If Rhino cannot see the same installation, add its absolute path to Hopper's `config.json` as shown in [Choosing Node](#choosing-node), then run `HopperCodeRestart`.
- **Grasshopper did not open:** `HopperCode` intentionally leaves Grasshopper unloaded. Submit a `gh_*` request in the browser. Hopper warns before opening Grasshopper and waits for its active definition. Run `HopperCodeStatus` for a typed startup or document error.
- **Tools fail in external Pi mode:** Run `HopperCode` first, then run `/hopper-backend` in Pi to reread the last-started connection profile. The GHZMQ component does not start the runtime.
- **Invalid connection token:** Run `HopperCodeStop`, then `HopperCode` to create a new instance profile and authenticated host connection. External Pi users should run `/hopper-backend` after the new instance starts.
- **Grasshopper shows offline in Rhino.Inside.Revit:** Keep Grasshopper visible while the agent is working and inspect `HopperCodeStatus` after refocusing Rhino. Older Rhino.Inside.Revit versions may still limit background Grasshopper work.
- **Plugin did not install:** Install [.NET 7 SDK](https://dotnet.microsoft.com/download), then run `pnpm run build:gh-plugin`. On Windows, set `HOPPER_GH_LIBRARIES` if auto-detect fails.
- **Stale plugin after `git pull`:** `node scripts/install-grasshopper-plugin.mjs --force`, then restart Rhino.

## License

MIT — see [LICENSE](LICENSE).
