# Testing

Keep this suite small. Retain a test when a plausible mistake could lose user
work, repeat a side effect, cross an authentication or document boundary, or
break recovery, and the behavior is difficult to verify by reading the code.

The retained guardrails cover:

- Document writes, rollback, script revisions, and crash-safe persistence.
- RPC compatibility, lost replies, duplicate execution, and transaction ownership.
- Concurrent tasks, cancellation, host startup, and recovery after reconnects.
- Authentication, credential revocation, file access, and rendered untrusted text.
- Browser submission and reconnect behavior, plus native package validation.

Do not add tests just to check constants, schemas already covered by the RPC
contract, forwarding wrappers, formatting, UI layout, or implementation text.
Use typechecking and code review for those. Temporary feature and regression
tests should be deleted after verification unless they protect one of these risks
and are difficult to replace with code review. A past regression or feature's
implementation history is not a reason to retain its test. Remove tests of mock
development servers, display helpers, performance accounting, and release
constants; use the actual build, package verifier, and staged runtime smoke for
packaging acceptance. Remove unused test fixtures and helpers with their tests.
Prefer extending an existing behavioral test over adding another mock-heavy suite.

Run the automated guardrails:

```sh
pnpm test
pnpm exec tsc --noEmit
pnpm exec tsc -p tsconfig.web.json
dotnet test dotnet/Hopper.Core.Tests/Hopper.Core.Tests.csproj
pnpm exec tsx scripts/cross-language-rpc-smoke.ts
```

For native document or script changes, check these manually in Rhino using a
throwaway model:

- Save, close, and reopen a `.3dm` and a `.gh` or `.ghx` file; verify their contents.
- Run a Python or C# edit and undo it; verify that the original geometry returns.
- Attempt a failing graph edit; verify that it leaves the existing canvas intact.

The automated suite does not verify Rhino's native save callbacks or undo behavior.
