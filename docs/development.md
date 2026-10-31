# Local development

Use Node.js 22.19.0 or newer and pnpm 11.5.3. Building native plugins also requires Rhino 8.20 or newer running .NET 8 and the .NET 8 SDK.

```bash
git clone https://github.com/tsoumdoa/hoppercode.git
cd hoppercode
pnpm install
pnpm dev
```

`pnpm install` installs dependencies without building or installing Rhino plugins. `pnpm dev` opens the web UI at `http://localhost:5174/#mock-running` with an in-memory mock host. It needs no Rhino, .NET, model credentials, or real backend. Messages receive canned replies. Reload with `#mock-question`, `#mock-failed`, or `#mock-empty` to try the other fixtures. Threads and settings stay in memory until you stop development with Ctrl+C. Tabs using the same fixture share threads, and reconnecting preserves them. Restart `pnpm dev` to reset the fixtures.

The mock supports thread archive/delete, questions, cancellation, recovery, image attachments, provider sign-in simulation, tool settings, skills, and conversation export. It uses the real request validators. Provider sign-in and plugin keys are simulated; submitted keys are discarded. It does not run Rhino operations or model calls, and stopping the host remains a terminal action.

The main commands are:

| Command | Purpose |
| ------- | ------- |
| `pnpm install` | Install dependencies |
| `pnpm dev` | Open the UI with mock data and hot reload |
| `pnpm build` | Build and verify macOS arm64 and Windows x64 Yak packages |
| `pnpm build --dev` | Compile host and UI into `dist` with source maps, without packaging |
| `pnpm build:install` | Build, verify, and replace the local Rhino 8 installation |
| `pnpm version:bump patch\|minor\|major` | Update the package and both native plugin versions together; choose one increment |
| `pnpm version:bump 0.3.0` | Set an explicit higher release version |
| `pnpm release --dry-run` | Validate and preview publishing the existing release |
| `pnpm release` | Publish the tested packages to Yak and create the GitHub tag and release |
| `pnpm check` | Typecheck the host and browser, then run the essential Vitest guardrails |
| `pnpm check:native` | Run .NET core tests and the cross-language RPC smoke test; requires .NET 8 SDK |
| `pnpm test` | Run Vitest tests |

Release builds require .NET and Rhino 8's Yak executable. `pnpm build` builds both platforms sequentially and writes to `artifacts/hoppercode-<version>-<target>`. It refuses a nonempty output directory. Use `pnpm build --output artifacts/my-release` for another destination; each target gets its own `mac-arm64` or `win-x64` subfolder. `--target mac-arm64` and `--target win-x64` remain available for a single target. Cross-built packages still need runtime testing on their target OS.

See [publishing to Yak](releasing.md) for release preparation and the `pnpm yak` install, test-server, and public upload commands.

Use `pnpm version:bump patch` to update all release versions together. After committing, building, and testing, `pnpm release` publishes both packages to Yak and creates the matching GitHub tag and release. See the [release guide](releasing.md) for dry-run and recovery options.

For local development, quit Rhino and run `pnpm build:install`. It builds only the current platform, verifies and smoke-tests a fresh package, stops the old Hopper host, and replaces the installed package without prompting. Each run uses a new staging directory, so repeated local builds need no output cleanup. Saved conversations remain available. Both platforms accept the same options:

```bash
pnpm build:install --open-rhino  # Install, then reopen Rhino
pnpm build:install --build-only # Build and smoke-test without changing the installation
```

`pnpm build --dev` is useful for debugging the compiled host or checking the built UI. It requires only JavaScript dependencies and writes source maps for both. For UI iteration with hot reload, use `pnpm dev`.

Run `pnpm check` before opening a PR. Run `pnpm check:native` for native or protocol changes. These commands do not exercise Rhino UI, document undo, or installed plugin behavior; verify those in Rhino when affected.

## Use the real host with hot reload

For real backend work, compile the assets and start the host:

```bash
pnpm build --dev
node dist/host/index.js --ensure-host --explicit-start --ui-dev-origin http://localhost:5173
```

Run `pnpm exec vite` in a second terminal. Vite reads the host endpoint from `~/.hopper/shared-control/control.json`. Start the host before Vite so the endpoint is available. `HOPPER_UI_PROXY_TARGET` can override it. If another host is already running, stop it through its browser UI before starting the rebuilt host with development-origin access.

Run `HopperCode` in Rhino to attach its documents. To authenticate the development page, open the private `~/.hopper/shared-control/control.json` locally and copy its `browserCredential` value into `http://localhost:5173/#<browserCredential>`. The browser removes the fragment after reading it. Keep this credential private; do not paste it into logs, screenshots, issues, or chat. The normal HopperCode workflow opens an authenticated link automatically and needs none of these development steps.

See the [script inventory](../scripts/README.md) for build helpers, tests, and manual diagnostics. Diagnostic utilities remain available directly, for example `node scripts/verify-rhino-package.mjs` and `pnpm exec tsx scripts/cross-language-rpc-smoke.ts`.

## Source layout

| Path | Contents |
| --- | --- |
| `web/` | React browser UI |
| `src/host/` | Embedded Pi runtime and local server |
| `src/protocol/` | TypeScript browser contracts and native RPC validators |
| `protocol/v2/` | Shared native RPC specification, metadata, and fixtures used by TypeScript and C# tests |
| `src/tools/` | Agent tools |
| `dotnet/` | Native Rhino and Grasshopper plugins |
| `mds/` | Bundled skills and references |
| `scripts/` | Build, packaging, and development utilities |

See [plugin development](plugins.md) to add a tool plugin and [shared host architecture](shared-host.md) for runtime details.

Browser snapshots are declared in `src/protocol/browser-snapshot.ts`. The host maps journal rows into this contract; the browser validates incoming messages and assembled patches before applying them. Payloads stay serialized on the wire so unchanged rows compare by value. Use the validated readers in `browser-payloads.ts` to access their contents. Treat received rows as immutable: patch application replaces changed rows, and validation caches unchanged row identities.

`web/src/hooks/use-shared-connection.ts` owns authentication, reconnection, and command replay. Drafts, conversation selection, and acknowledgement effects stay together in `App`. Journal migrations and snapshot reads live in `journal-migrations.ts` and `journal-reads.ts`; `TaskJournal` retains transaction ownership.
