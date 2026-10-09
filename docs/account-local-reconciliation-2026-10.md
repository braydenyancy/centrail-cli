# Account-local CLI reconciliation — 2026-10-08

Local candidate: `dvoid/centrail-cli/account-local-compat-current`, based on the
complete hook candidate `f712d2b`. The prior account-local branch at `2449a55`
is preserved. The separate hook PR worktree is unchanged. This is uncommitted
local work; no fetch, push, PR, merge, tag, publish or production action occurred.

The candidate reapplies the account-local contract and pairing disclosure to
current hook source, including the Windows child-stdio fix. Before requesting
pairing, an already-paired CLI explains that its next sync can copy locally
available history into the new account and that the old account keeps its copy.
Existing same-account checkpoints, changed/unknown-account checkpoint resets,
and older servers' positive `heldElsewhere` responses remain unchanged. A
regression assertion verifies the history disclosure occurs before the pairing
request; existing tests cover checkpoint and legacy-server compatibility.

All release metadata and the generated plugin bundle identify this local
candidate as `0.7.5-account-local.0`. This avoids impersonating released 0.7.3
or the separate 0.7.4 hook candidate. It reserves no registry version and is not
an instruction to publish a prerelease. Version availability and final main
ancestry must be checked again when release is authorized. Prefer integrating
this narrow change after the hook PR lands, or explicitly composing both in a
new reviewed release; never version-bump the stale 0.7.2 runtime as the fix.

The browser approval disclosure belongs to app repair A. App A must deploy and
pass old/current-client canaries before releasing this CLI wording. A’s
account-local writer accepts the replay; compatibility with older servers means
reading their response, not making them preserve a second account’s history.
Native Node 20/24 Linux/macOS/Windows checks must run on the eventual release
candidate. No installed hooks or plugin caches were modified.

The estate auth atlas §2 maps dvoid identity infrastructure, not Centrail’s
product pairing flow. No mapped estate flow, pairing credential behavior or
scope behavior changed. The product contract above is checked against the
local CLI source and fixtures. Production behavior remains unverified within
this local-only task.

## Validation

- `npm run build` and `npm run typecheck` pass.
- Generated `packages/cli/dist/index.js` and the tracked plugin bundle are
  byte-identical. Hook runtime source remains identical to `f712d2b`.
- Full local tests on Linux / Node 26.8.2: 480 CLI tests and 166 parser tests
  pass; one optional parser control remains intentionally skipped. These checks
  do not replace the eventual native Node 20/24 release matrix.
- `git diff --check` passes.

The first sandboxed test run was invalidated by `EPERM` for child processes and
loopback HTTP fixtures. The complete suite was rerun with approved local test
permissions; this did not authorize remote tests or production access.
