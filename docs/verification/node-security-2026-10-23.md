# October 2026 Node security update

Based on main `4d922ba890703199ce91df6a3e26728b601d5df7`, freshly fetched again after verification.
The [Node October 21 security advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases/)
identifies patched Node 22.23.4 and 24.22.1. Root, CLI and parser engines now accept
`>=22.23.4 <23 || >=24.22.1 <25`; `.node-version` selects 24.22.1. All workflow
Node runtimes are pinned to exact patched releases. The native CI matrix retains
Ubuntu, macOS and Windows, with 22.23.4 and 24.22.1 replacing Node 20/24 floating pins.
The CLI compiler target is Node 22; rebuilding produces the identical committed plugin bundle.

## Repeatable checks

With each exact Node release selected and its npm on PATH, run from the repository root:

```sh
node --version
npm --version
npm ci --no-audit --no-fund
npm run verify
node scripts/check-doc-links.mjs
git diff --exit-code -- plugins/centrail/scripts/centrail.mjs
```

Local Linux results on both Node **24.22.1 / npm 11.19.1** and **22.23.4 / npm 10.9.9**:

- Fresh locked installation, builds and typechecks passed.
- CLI: 696 tests passed, one skipped. Parsers: 258 passed, one skipped.
- Synthetic server contract: 11 passed. Release-policy tests: 18 passed.
- Both packed consumers installed and passed their smoke checks at the unchanged coordinated version 0.9.0.
- Python comparison-gate self-tests: 15 passed. Optional external comparison/runtime probes were not requested.
- Documentation link check passed; the update also repaired two stale links to the removed release-channel blocker in current integration/plugin instructions.
- The dependency lockfile changes only the three workspace engine declarations; no dependency version, resolution or integrity changed.

These are local Linux results; native macOS/Windows CI and publication have not run on this branch.
Package engines are advisory under normal npm configuration; the runtime itself must be upgraded.
This work makes no dependency-audit or complete vulnerability-remediation claim.

## Compatibility and concurrent work

Removing Node 20 and untested major lines is a breaking support change. Use a `fix!`
commit with a `BREAKING CHANGE` note. Existing `bump-minor-pre-major` release configuration
should propose 0.10.0 from 0.9.x, through the normal coordinated release PR and immutable
tag pipeline. No package/plugin versions or release pointers were changed here. The open
0.9.1 release PR #34 must be refreshed if this change lands first. PRs #31 and #32 were
already merged into this base. Open Vite-upgrade PR #33 is separate; its dependency change
was not folded into this runtime update, and no existing PR branch was modified.

GitNexus initially had no CLI index. Index-only analysis first failed at its 256 MiB
buffer-pool cap, then succeeded with a 1 GiB buffer pool and FTS disabled. It reports
truncated process discovery, so absence of an affected flow is not assurance of no impact.
`detect-changes --scope all --repo .` completed with low risk, ten documentation section
symbols and zero reported processes before this receipt was added. Final staged detection
is recorded below; direct diff review and the two complete gates carry the verification.

Final staged detection: 20 files, the same ten documentation section symbols, zero
reported processes, low risk. New runtime/version metadata and this receipt have no
indexed execution symbols; this is a scope check, not security assurance.

## Installed hook runtime repair

The installed CLI remains 0.9.0; no unpublished package was installed. An audit of
`~/.config/centrail/bin/centrail-hook` found that discovery prefers Node on PATH,
then the recorded `~/.config/centrail/node`, before its stable pinned fallback.
The recorded path still named `~/.local/share/mise/installs/node/22.23.1/bin/node`
and executed v22.23.1, even though the stable Node 22 alias now resolves to 22.23.4.
Thus a GUI-launched hook with no Node on PATH would still use an unpatched runtime.

With owner authorization, only the recorded-node sidecar was atomically replaced
with `~/.local/share/mise/installs/node/24.22.1/bin/node`, after that executable
reported v24.22.1. Its existing mode 0664 was preserved. Hook definitions, installed
CLI/package files, agent settings and running agent processes were not changed.

Discovery-only probes evaluated the existing launcher's prefix before its CLI
execution block, then printed the selected runtime and ran only `node --version`:

| Environment | Before | After |
| --- | --- | --- |
| Terminal PATH | Node 24 alias → v24.22.1 | Node 24 alias → v24.22.1 |
| Empty GUI PATH | Recorded Node 22.23.1 → v22.23.1 | Recorded Node 24.22.1 → v24.22.1 |

No setup, capture, sync or global package installation ran. This verifies runtime
discovery in those two environments, not a new end-to-end agent hook execution.
