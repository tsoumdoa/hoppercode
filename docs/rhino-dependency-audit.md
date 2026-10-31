# Rhino dependency audit

The subsequent runtime dependency bundling change combines
TypeBox and Pi agent core modules to reduce startup file reads. The measurements
below describe the preceding pruning pass.

Audited on 2026-09-11 against PR #101 at `f0e3632`, with the locked production dependencies. This pass removes 639 files and 6,463,947 unpacked bytes from each target. Every retained staged file has the same SHA-256 as the preceding optimized package.

## Removed files and runtime evidence

Rules live in `scripts/rhino-dependency-pruning.mjs`. Packaging checks all listed versions and paths before deleting anything. Unknown versions or missing paths fail the build. The staged verifier rejects these paths if they reappear. These rules apply only to the installed release tree.

| Package | Audited version | Removed | Evidence |
| --- | --- | --- | --- |
| OpenAI | 6.40.0 | `src/`, 2,176,407 bytes | Node exports resolve compiled `.mjs` and `.js` files. Neither runtime tree imports source. Credential providers read caller-supplied token paths through `fs/promises`. Both module formats and all auth helpers remain. |
| Anthropic | 0.124.0 | `src/` | The 0.124.0 export map matches 0.123.0. Node exports resolve compiled modules. Runtime credential and memory helpers read user files, not package source. `internal/node` and the compiled credential chain remain. |
| Zod | 4.6.6 | `src/` | Standard Node import/require conditions resolve compiled modules. Only the development `@zod/source` condition selects TypeScript source; Hopper does not enable it. Keep v3, v4, mini, locales, and both compiled formats. Rechecked for the 0.3.1 security update; measurements below remain those of the original pruning pass. |
| cmake-ts | 1.0.2 | Source, four root build configs, build cache, `build/main.{js,mjs}` and `build/lib.{js,mjs}`, 1,369,362 bytes | ZeroMQ 6.5.0 `lib/load-addon.js` requires `cmake-ts/build/loader`. Both standalone loader formats import only Node builtins and read ZeroMQ's `build/manifest.json` and native addon paths. The build CLI is referenced by ZeroMQ's install script, which runs before pruning. Neither loader imports the build CLI/library. Both loaders and package metadata remain unchanged. |

Reviewed compiled imports and file reads in these packages and searched the staged dependency tree for `cmake-ts` consumers. No SDK runtime code was patched. The existing Pi bundle deduplication remains a separate rule.

## Retained opportunities

- `web-streams-polyfill` 3.3.3 occupies 2,738,451 bytes. `fetch-blob/streams.cjs` references `dist/ponyfill.es2018.js` as its fallback after Node streams. Its root, ES6, ES2018, and ponyfill package manifests also expose distinct public builds. Keep the package intact in this pass instead of assuming extensions never import those paths.
- OpenAI, Anthropic, and Zod expose both ESM and CommonJS entrypoints. Pi loads dynamic TypeScript extensions through Jiti, so a static scan of Hopper's imports does not establish that one format is unused. Keep both. The staged smoke loads both formats, including Zod v3 and v4.
- `@google/genai` 1.52.0 includes Node, browser, and default builds. Its manifest exposes `/web`, `/node`, tokenizer, and internal entrypoints. The browser/default builds are another possible saving, but this pass preserves public SDK exports for extensions.
- Pi's HTML exporter reads `dist/core/export-html/template.css` and adjacent templates/vendor scripts from disk. Keep those assets. `highlight.js/styles` also remains; removing a package's public styles needs a separate export/extension audit. The web application's CSS and drawing fonts are unchanged.
- Keep esbuild and Jiti for typed extensions, all target-native credential/lock/ZeroMQ bindings, Photon WASM, and Pi's image worker. Build-tool names alone are insufficient evidence of unused runtime code.

## Measurements

Before means the preceding optimized PR package, not the original PR base. Values are bytes. Yak is compressed; staged and dependency sizes are unpacked and exclude the generated package report.

| Component | Before this pass | After this pass | Saved |
| --- | ---: | ---: | ---: |
| macOS arm64 staged | 89,165,920 | 82,701,973 | 6,463,947 |
| Windows x64 staged | 92,326,070 | 85,862,123 | 6,463,947 |
| macOS Yak | 39,121,489 | 37,432,662 | 1,688,827 |
| Windows Yak | 40,440,619 | 38,751,792 | 1,688,827 |
| macOS Node dependencies | 63,815,584 | 57,351,637 | 6,463,947 |
| Windows Node dependencies | 66,976,528 | 60,512,581 | 6,463,947 |

File counts are now 6,461 on macOS and 6,462 on Windows. Staged ceilings are 83 and 86 MiB, with dependency ceilings of 57 and 60 MiB. These leave roughly 4 to 5% headroom. Browser and Node-code budgets are unchanged.

## Verification and limits

- Clean `package-rhino.mjs --target mac-arm64 --output artifacts/dependency-audit-mac --yak` and equivalent `win-x64` builds passed. Both passed path, native architecture, hash, and tightened category/total budget verification.
- Each Yak contains exactly the expected staged paths. Runtime file hashes match the staged manifest. Yak normalizes its embedded `manifest.yml` and adds platform metadata, so that file differs from the staging input as expected.
- `pnpm test` passed 405 tests. Added checks cover version/layout failure before deletion and retained native loaders.
- The macOS staged smoke passed on Node v26.8.1: every host chunk; Hopper and Pi session creation; typed extension loading; every provider, API implementation, and auth module; SDK ESM/CommonJS imports; temporary Pi credential create/read/delete; OpenAI and Anthropic token-file reads; native keyring module loading; actual ZeroMQ in-process send/receive; SQLite; esbuild; image resize API and direct image worker/WASM.
- Credential tests use temporary fixture values. They do not exercise OS credential writes or live provider authentication/API calls.
- Windows binaries cannot execute on this macOS arm64 machine. Windows runtime smoke, Yak installation, and in-Rhino acceptance remain unverified. This pass does not claim a manual browser or Rhino test, or validation on the minimum supported Node release.

Reproduce the runtime check with `node scripts/smoke-staged-host.mjs <stage>`. Run it on a Windows x64 machine against the Windows package before native release acceptance.

## 0.3.1 dependency review

The refreshed macOS production tree contains 60,905,718 bytes of dependencies.
The published 0.3.0 archive contains 59,538,380 bytes, already close to the former
57 MiB allowance. The largest additions are the security updates to Zod
(661,235 bytes) and Undici (256,555 bytes), followed by SDK internals and the new
Minimatch implementation. These are runtime modules, including both public
ESM and CommonJS exports; deleting them would compromise supported SDK use.

Dependency allowances are now 59 MiB for macOS and 62 MiB for Windows. The total
staged ceilings remain 83 and 86 MiB. Zod 4.6.6's exports and compiled file reads
were rechecked before retaining the existing source-only pruning rule. The
full dependency audit reports no known vulnerabilities. Package validation and
the staged Windows runtime smoke remain release checks.
