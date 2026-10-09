# CLI verification — 2026-10-09

The pending collection, account-local replay and comparison changes were applied
in an isolated checkout based on `8026d04`. Verification used Linux and Node
`v24.21.0`. Dependencies were reused locally, with `@centrail/parsers` resolving
to this checkout rather than the original working tree.

| Check | Result |
| --- | --- |
| `npm test` | 557 CLI tests and 258 parser tests passed; 1 optional control wrapper skipped |
| `npm run typecheck` | Passed, including parser declaration build |
| `npm run build` | Passed; CLI and plugin bundles rebuilt and byte-identical |
| `npm run test:comparison-gate` | 15 tests passed |
| `npm run test:comparisons -- --out <fresh-directory>` | 15 fixture cases, zero failures |
| `git diff --check` | Passed |

The comparison suite executed pinned Tokscale, ccusage and Claude Code Usage
Monitor where their formats overlap. Each result is checked against source
expectations and reviewed tool-specific baselines; passing does not assert that
all competitors produce identical token buckets. The isolation probe confirmed
the personal home directory was absent and network connection failed. The
optional parser control wrapper stays disabled by default; the complete comparison
suite was executed separately above.

The latest-main hook ownership, plugin setup, version checking and doctor JSON
implementations remain unchanged. Their tests ran with the full CLI suite. Browser
launching is mocked at the process-spawn boundary; verification opens no desktop
browser. The generated plugin bundle was rebuilt from this combined source.

An initial restricted-sandbox run could not create localhost/Git subprocesses
and network namespaces. Tests and comparisons passed after granting the needed
execution permissions; comparison processes still ran inside their own offline
filesystem/network namespaces. Hosted Node20/24 checks subsequently passed on Ubuntu, macOS and Windows,
including fresh installs, build, bundle consistency, typecheck and tests. Plugin
validation and the advisory server-contract job also passed. The first hosted
comparison run found that npm tar extraction did not set ccusage executable
permission; provisioning now explicitly sets it. The corpus, protocol and baseline
were unchanged; the repaired job is tracked in PR #15. Production rollout and
historical database cleanup are not claimed.

Remaining collection limits are documented in
[the integration notes](./tokscale-integration-2026-10.md): deleted ambiguous local
copies cannot recover lost identity evidence, downward corrections and previously
stored duplicates require separate reconciliation, and Pi/Gemini conflict checks
read the configured store. Estimates are list-price equivalents, not proof of
actual subscription or API payment.
