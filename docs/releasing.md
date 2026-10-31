# Versioning and publishing Hopper to Yak and GitHub

Keep the release scripts and this guide in Git. Keep built `.yak` files and their build records in ignored `artifacts/` folders. `pnpm release` publishes the binaries to Yak and attaches the same files to a GitHub Release. Yak stores login credentials outside the repo; never commit or share them. The package documentation links to `https://github.com/tsoumdoa/hoppercode`, the hoppercode repository.

Publish through Yak and GitHub only. npm publishing is disabled. The `stable/0.1` branch preserves the final `hopper-pi` extension release and its setup instructions.

Run the local checks in [TESTING.md](../TESTING.md) before preparing a release. GitHub Actions also runs `pnpm check` and `pnpm check:native` for pull requests and pushes to `main`. Package builds and in-Rhino acceptance checks remain local.

## Version and release shortcuts

Choose one version command. Each example below starts independently from `0.2.0`.

| Command | Result | Behavior |
| --- | --- | --- |
| `pnpm version:bump patch` | `0.2.1` | Increment patch |
| `pnpm version:bump minor` | `0.3.0` | Increment minor and reset patch to zero |
| `pnpm version:bump major` | `1.0.0` | Increment major and reset minor and patch to zero |
| `pnpm version:bump 0.3.0` | `0.3.0` | Set an explicit version higher than the current version |

The command updates `package.json` and both native plugin projects together. It only edits version fields; it does not commit, tag, build, install, or publish. The helper supports stable releases; it rejects mismatched project versions, unchanged or lower explicit versions, and prerelease strings.

Preview a bump without changing files:

```sh
pnpm version:bump major --dry-run
```

For example, a major bump from `1.4.7` becomes `2.0.0`. The matching GitHub tag is created later by `pnpm release`, using the resulting version, such as `v2.0.0`.

For each release:

1. Bump the version with `pnpm version:bump patch`, `minor`, `major`, or an explicit higher version.
2. Review and commit all intended release changes. The working tree must be clean before building.
3. Run `pnpm build`, then test those packages on Mac and Windows as described below.
4. Run `pnpm release --dry-run`, then `pnpm release`.

The release command requires GitHub CLI, authenticated with `gh auth login`. It detects the repository from `origin`, checks the committed version and both archives, pushes the current branch to origin, and creates a draft GitHub release targeting the exact build commit. It attaches both packages, uploads them to public Yak, then publishes the GitHub release with generated notes and tag `v<version>`. You can run it from Mac or Windows with both build folders present.

`pnpm release --github-only` creates the GitHub tag and release when the exact same files have already been published to Yak using the separate commands below. Both release modes accept `--output <dir>` matching your build command.

| Command | Behavior |
| --- | --- |
| `pnpm release --dry-run` | Validate the release and print planned commands without pushing, creating a release, or uploading |
| `pnpm release` | Push the current branch, create a GitHub draft with both archives, publish both to Yak, then publish the GitHub release |
| `pnpm release --github-only` | Push the current branch and create the GitHub tag and release with both archives; skip Yak |

Release dry runs still require a clean committed checkout, matching build records, GitHub CLI authentication, and remote tag checks. They may contact GitHub for read-only checks. An existing remote version tag stops the command. The release command uses the existing version and tested archives; it does not bump the version, commit changes, rebuild, or run Rhino tests.

The services cannot publish as one atomic transaction. If something fails, earlier successful operations remain. See recovery below before retrying.

## Prepare a release

Use `pnpm version:bump` to keep the version in `package.json`, `dotnet/Hopper.Rhino/Hopper.Rhino.csproj`, and `dotnet/Hopper.Grasshopper/Hopper.Grasshopper.csproj` identical. The native plugin release starts at `0.2.0`. Review the public description, authors, and URL in `scripts/package-rhino.mjs`.

```sh
pnpm build
```

This builds and verifies both distributions, including the public manifest, and applies the minimum Rhino version tag. For 0.2.0 the final files are:

```text
artifacts/hoppercode-0.2.0-mac-arm64/hoppercode-0.2.0-rh8_20-mac.yak
artifacts/hoppercode-0.2.0-win-x64/hoppercode-0.2.0-rh8_20-win.yak
```

Each build also writes a sibling `-release.json` record with the source commit, whether the checkout had changes, and the archive's SHA-256. Keep those records with the build folders when copying them to another machine. `pnpm release` checks that both archives came from the current clean commit and still match their hashes. Local development builds remain allowed with uncommitted changes, but cannot be published by this command. Archives built before these records were added need rebuilding.

Do not reuse older 0.1.90 archives. Both distributions must come from the same source revision. The `mac` distribution supports Apple Silicon only. Users need Rhino 8.20+ running .NET 8 and stable Node.js 22.19.0+ installed separately. On Windows, select .NET Core with `SetDotNetRuntime` if necessary, then restart Rhino.

Builds refuse to overwrite nonempty output folders. For another build use `pnpm build --output artifacts/release-candidate-2`, and pass `--output artifacts/release-candidate-2` to the local install and push commands below.

For a single-platform test build, `pnpm build --target mac-arm64 --output artifacts/mac-test` writes directly into `artifacts/mac-test`. Install it with `pnpm yak install local --output artifacts/mac-test`. Use `win-x64` on Windows. Local installation accepts either this direct layout or the two-platform parent folder. Combined upload and release commands require the parent folder containing both `mac-arm64` and `win-x64` subfolders.

## Test the existing packages

The commands work in Mac Terminal and Windows PowerShell. Use `pnpm.cmd` if PowerShell blocks the pnpm shim. Quit Rhino before installation.

```sh
pnpm yak install local
```

Run this on each target machine. Copy the Windows build folder to the same relative path in the Windows checkout, or build there from the same revision. To test a downloaded archive without a checkout, use Rhino's Yak executable directly: `yak install --source <folder-containing-the-yak> hoppercode 0.2.0`.

Use a clean test installation. Yak may skip installation if the same version is already installed. On a test machine, use `yak uninstall hoppercode` before switching between local, test-server, and public copies of the same version. Remove old development plugin registrations or Grasshopper Libraries copies so they cannot mask a broken package.

Restart Rhino and run `HopperCode`. Check provider sign-in, send a message, perform a Rhino operation, and perform a Grasshopper operation. The command installs the package; these runtime checks still need a person on each OS.

## Test the upload

From either machine containing both build folders:

```sh
pnpm yak push test --dry-run
pnpm yak push test
```

The second command opens Rhino Account login, uploads both distributions, and searches for the package. On each test machine, install it from the server and repeat the runtime checks:

```sh
pnpm yak install test
```

The test server is public and clears nightly. It is a rehearsal, not long-term storage.

## Publish to Yak separately

Use `pnpm release` above to publish to both Yak and GitHub. These commands remain available for a Yak-only release.

Check the name before the first release:

```sh
pnpm yak search public
```

If `hoppercode` already belongs to someone else, resolve ownership or choose a different package name before uploading. Use the Rhino Account that should own the package. The first successful upload establishes ownership.

After both platforms pass testing, publish the exact same files:

```sh
pnpm yak push public --dry-run
pnpm yak push public
```

The script checks that both archives exist before login, then uploads them sequentially. If the second upload fails, the first remains published. Retry only the failed file with `yak push --source https://yak.rhino3d.com <file>` after resolving the error. An already published distribution cannot be overwritten. Code or metadata fixes need a new version; bump all three version fields and rebuild both targets.

Finally, find `hoppercode` in Rhino's `PackageManager` on each OS, install it, restart Rhino, and repeat the runtime checks. A normal Git push or build does not publish packages. Only `pnpm release` or an explicit Yak `push` command uploads files.

## Recover an interrupted combined release

The combined command stops at the first failure. It never overwrites an existing remote tag. Inspect the draft and Yak uploads before retrying:

```sh
gh release view v0.2.0 --repo tsoumdoa/hoppercode
pnpm yak search public
```

Replace the example version for later releases. A Yak search alone does not prove both distributions are present; use the upload output and test installation on both OSes.

If GitHub draft creation or asset upload failed, inspect the draft and attach any missing archives with `gh release upload v0.2.0 <file> --repo tsoumdoa/hoppercode`. Do not replace already uploaded assets with different builds.

If Yak failed, upload only the missing distributions with `yak push --source https://yak.rhino3d.com <file>`. Use the same tested archives. Once both Yak distributions and both GitHub assets are present, finish the existing draft:

```sh
gh release edit v0.2.0 --repo tsoumdoa/hoppercode --draft=false --latest
```

If only the final GitHub publication failed, that same edit command completes it. Do not rerun the combined command against an existing draft or published tag. For code or metadata fixes, bump the version and rebuild instead.

Use `pnpm yak --help` for options. Set `HOPPER_YAK` to an absolute executable path if Rhino is installed somewhere else. Scripts use Rhino's existing Yak login storage and do not write credentials to the checkout.

References: [Yak CLI](https://developer.rhino3d.com/en/guides/yak/yak-cli-reference/), [publishing and ownership](https://developer.rhino3d.com/en/guides/yak/pushing-a-package-to-the-server/), [distribution tags](https://developer.rhino3d.com/guides/yak/the-anatomy-of-a-package/), [GitHub release creation](https://cli.github.com/manual/gh_release_create).
