# Script inventory

Use the `pnpm` commands in [local development](../docs/development.md) for everyday work. The files below support those commands or provide manual diagnostics. A script without a `package.json` entry can still be imported by another script, Vite, or a test.

## Build and package

| Script | Purpose and caller |
| --- | --- |
| `build.mjs` | `pnpm build`; chooses development assets or platform packages |
| `build-assets.mjs` | Compiles TypeScript and builds the browser UI; called by development and package builds |
| `package-rhino.mjs` | Stages native plugins, host, dependencies, and Yak archives; called by `build.mjs` |
| `install-grasshopper-plugin.mjs` | Builds `dotnet/Hopper.Grasshopper` and `dotnet/Hopper.Rhino`, then copies their artifacts; called by `package-rhino.mjs`. The filename predates the current layout and does not refer to a `grasshopper-plugin/` source folder |
| `build-rhino-host.mjs` | Bundles the packaged Node host; called by `package-rhino.mjs` |
| `bundle-pi-runtime.mjs` | Bundles the Pi SDK; called by `package-rhino.mjs` |
| `bundle-rhino-dependencies.mjs` | Bundles selected production dependencies; called by `package-rhino.mjs` |
| `pack-startup-sources.mjs` | Packs dependency sources used during startup; called by `package-rhino.mjs` |
| `prune-rhino-host.mjs` | Removes duplicate Pi modules and audited dependency files; called by `package-rhino.mjs` |
| `rhino-dependency-pruning.mjs` | Shared dependency pruning rules used by pruning and package validation |
| `rhino-package-rules.mjs` | Shared package allow/deny rules and target definitions used by validation and size reports |
| `verify-rhino-package.mjs` | Checks staged files, binaries, manifests, and size budgets; called by packaging and available directly |
| `rhino-package-size.mjs` | Shared size categorization and budget checks used by validation and reporting |
| `report-rhino-package-size.mjs` | Writes the package size report; called by `package-rhino.mjs` |
| `excalidraw-assets.ts` | Vite plugin that limits bundled Excalidraw UI translations; imported by `vite.config.ts` |

## Install and release

| Script | Purpose and caller |
| --- | --- |
| `install-rhino.mjs` | `pnpm build:install`; dispatches to the platform installer |
| `install-rhino-mac.sh`, `install-rhino-win.ps1` | Build, verify, smoke-test, and install the local platform's package |
| `smoke-staged-host.mjs` | Checks that the staged host starts and serves its UI; called by both platform installers |
| `stop-shared-host.mjs` | Stops the previous shared host before installation; called by both platform installers |
| `version-bump.mjs` | `pnpm version:bump`; updates package and native plugin versions together |
| `yak.mjs` | `pnpm yak`; wraps Yak operations and is also called by the release script |
| `release.mjs` | `pnpm release`; validates and publishes prepared packages |
| `release-utils.mjs` | Version and archive helpers shared by build and release scripts |

## Development and checks

| Script or files | Purpose and caller |
| --- | --- |
| `ui-mock-host.mjs` | `pnpm dev`; starts the mock host and Vite |
| `ui-mock-backend.mjs` | In-memory backend for the mock host |
| `fixtures/chat-images/*.png` | Image attachment examples loaded by the mock backend |
| `ui-host-proxy.ts` | Resolves the shared host endpoint for Vite's HTTP and WebSocket proxy |
| `cross-language-rpc-smoke.ts` | `pnpm check:native`; exercises TypeScript-to-C# RPC through a .NET test host |
| `*.test.ts` | Script guardrails discovered by `vitest.config.ts` and run by `pnpm test` |

## Manual diagnostics

These are standalone tools rather than automatic build steps. They still target the current browser build and shared host.

| Script | When to use it |
| --- | --- |
| `analyze-web-bundle.mjs` | Inspect browser chunk and module sizes with an in-memory Vite build; writes `artifacts/web-bundle-report.json` by default |
| `profile-runtime-imports.mjs` | Measure import timing, module counts, and native library loads in a staged `runtime/host` directory |
| `benchmark-host-startup.mjs` | Measure a packaged host's startup time with configurable runs, Node executable, and JSON output; use `--help` for options |
| `shared-host-native-smoke.mjs` | Exercise native document operations with a manually connected Rhino on macOS; requires compiled `dist`, an installed package, and explicit `--allow-new-test-documents` |
| `windows-rhino-launch-smoke.mjs` | Exercise Windows Rhino launch and delegation admission against a live host; requires compiled `dist`, a connected source PID, and explicit `--allow-new-test-document` |

The native smoke scripts create test documents and require manual Rhino setup. They are not part of the automated suite. Read their usage and prerequisites before running them.
