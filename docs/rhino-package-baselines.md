# Rhino package size baselines

Clean staging on 2026-09-06 with Pi 0.85.1, pnpm 11.5.3, and the Excalidraw editor produced these payload baselines before Yak compression:

| Target | Files | Bytes | Approximate size | Ceiling |
| --- | ---: | ---: | ---: | ---: |
| `mac-arm64` | 12,037 | 111,759,813 | 106.6 MiB | 128 MiB |
| `win-x64` | 12,038 | 113,587,085 | 108.3 MiB | 128 MiB |

The previous Pi 0.85.0 baselines were 87.1 MiB for macOS and 88.9 MiB for Windows. Their 93 MiB and 92 MiB ceilings predated the drawing editor and blocked local installation after it was added. Both targets now use a 128 MiB ceiling.

Both manifests contain 21,261,281 bytes of browser assets, including 13,107,068 bytes of locally hosted Excalidraw fonts. Excalidraw stays a build dependency; its development package is not installed in the host's production dependencies. The macOS Yak archive is 43.4 MiB.

The payload includes Pi's esbuild runtime and exactly one esbuild executable for the target. Each generated SHA-256 manifest was checked for the target binary and the absence of other esbuild architectures. Update a ceiling only after inspecting the generated manifest and recording a new clean baseline here.

Both packages were staged on macOS arm64. The macOS host modules, native ZeroMQ, and esbuild transform smoke test passed with Node 26.8.1. Windows staging passed binary and package verification; its executable was not run on macOS.

These checks do not replace native Yak installation and Rhino smoke tests on macOS arm64 and Windows x64.
