# hoppercode

Hopper is a native Rhino 8 plugin for working on Rhino models and Grasshopper definitions with AI. It serves a local web UI for chatting with the agent, choosing models, and managing conversations. Under the hood, it uses Pi for the agent runtime and authentication across multiple model providers, including provider sign-in and API keys. You do not need to install the Pi CLI separately.

Before 0.2.0, Hopper was a Pi extension. The 0.2.0 workflow uses the native plugin and browser UI. The 0.1 extension is deprecated in favor of the native plugin and remains available on the [stable/0.1 branch](https://github.com/tsoumdoa/hoppercode/tree/stable/0.1), with its own setup instructions.

## Install

Supported platforms are macOS Apple Silicon and Windows x64, with Rhino 8.20 or newer running .NET 8. On Windows, use `SetDotNetRuntime` to select .NET Core and restart Rhino if it is configured for .NET Framework. Install stable Node.js 22.19.0 or newer; Node is not bundled.

To build and install from source, you also need Git, pnpm 11.5.3, and the .NET 8 SDK. Quit Rhino, then run these commands in Terminal or PowerShell:

```sh
git clone https://github.com/tsoumdoa/hoppercode.git
cd hoppercode
pnpm install
pnpm build:install --open-rhino
```

This builds and verifies a native Yak package, replaces any installed `hoppercode` or legacy `hopper-pi` package, and reopens Rhino. Saved conversations remain available. On Windows, use `pnpm.cmd` if PowerShell blocks the pnpm shim.

If you used the old Grasshopper installer, move its `hopper-pi` folder out of Grasshopper's Libraries before launching Rhino to avoid duplicate plugins.

## Run

1. Run `HopperCode` in Rhino to open the browser UI.
2. Connect a model provider and choose a model in the UI. Hopper shares Pi's `~/.pi/agent/auth.json` by default, so existing Pi credentials are available.
3. Ask Hopper to inspect or edit your model. Grasshopper loads when needed; no canvas component is required.

Run `HopperCode` in each document you want to connect, then choose a document beside the chat input. Run it again to reopen a closed browser tab. Closing the tab leaves active work running; use **Stop host** in the browser to stop the background host.

If startup fails, run `HopperCodeStatus` and see [troubleshooting](docs/troubleshooting.md).

## Configure skills

Open **Skills & Markdown** in the sidebar to preview or enable and disable bundled skills. To add your own instructions, put `.md` files in **Your Markdown folder**, or select an existing folder with **Use folder**. For a skill with references, create a folder containing `SKILL.md` and related Markdown files.

Changes are picked up while Hopper is idle or before the next prompt, and settings survive restarts. See [skill configuration](docs/skills.md) for folder paths, frontmatter, and limits.

## Develop or customize

After cloning and running `pnpm install`, start the browser UI with mock data:

```sh
pnpm dev
```

This opens `http://localhost:5174/#mock-running` with hot reload. It needs no Rhino or model credentials and returns canned replies.

To try your changes in Rhino, quit Rhino and run `pnpm build:install --open-rhino` again.

| Command | Purpose |
| --- | --- |
| `pnpm build --dev` | Compile the host and UI with source maps |
| `pnpm build:install --build-only` | Build and smoke-test the local package without installing |
| `pnpm build` | Build and verify macOS and Windows Yak packages |
| `pnpm check` | Typecheck the host and browser, then run the essential Vitest guardrails |
| `pnpm check:native` | Run .NET core tests and the cross-language RPC smoke test; requires .NET 8 SDK |
| `pnpm test` | Run Vitest tests |

See [local development](docs/development.md) for connecting a hot-reloading UI to the real host, build options, and the source layout.

## Documentation

- [Agent tools](docs/tools.md), [tool controls](docs/tool-controls.md), and [settings storage](docs/tool-policy-storage.md)
- [Document management](docs/document-management.md) and [Rhino script workspaces](docs/rhino-script-workspace.md)
- [Firecrawl setup](docs/firecrawl.md) and [adding tool plugins](docs/plugins.md)
- [Thread history](docs/thread-history.md) and [shared host architecture](docs/shared-host.md)
- [Bundled skills](mds/skills/), [agent references](mds/reference/README.md), and [cookbook benchmarks](docs/gh-cookbook-benchmarks.md)

## License

MIT. See [LICENSE](LICENSE).
