# Independent documentation review — 2026-10-15

> Historical review of the revisions named below, not a live status report. See [usage](../usage.md), [verification](../verification.md) and [releases](../releases.md) for maintained guidance.

This follow-up rechecked the earlier review's conclusions against implementation,
including current main and unmerged CLI #32. It supersedes the earlier receipt's
privacy/disclosure conclusions; its historical test results remain unchanged.

## Reviewed state

- Main: `3c5f962d0e00ff8f81cf2c8a56d4da811c8c2262`.
- Documentation #31 before corrections: `538e7fda14df26bc8f22d227e91797c8e60b7e82`.
- Implementation #32: `8fb718dd6fcd6e1a6cd0b9d1b4e4ec87567af874`, unmerged.
- Both PRs had no conversation comments, reviews or inline comments. Their Linux,
  macOS and Windows Node 20/24 jobs were green; live server-contract jobs were
  intentionally skipped. Main and both remote heads were fetched again before push.

Founder context: app `docs/current/business.md`, October model-review and design
solidification decisions. No pricing, entitlements, strategy, collection or runtime
behavior changes. The ambition remains; attribution and estimates get their actual
limits. These findings require correcting descriptions, not the business model.

## Corrections and evidence

| Group | Finding and correction | Implementation evidence |
| --- | --- | --- |
| Privacy inspection | README, npm/plugin README, help, pairing/setup completion and comments falsely imply a complete successful upload record. Describe the last **attempted usage batch**, excluding earlier batches and attribution/fate requests. Empty inspection now says no batch was saved. | `commands/sync.ts:217–225` writes before fetch; `commands/scope.ts:118–123`; `sync.server.test.ts` now reproduces a 503 with the attempted batch still saved. |
| Pairing disclosure | Add already-uploaded usage extras, billing-route labels and commit facts; clarify that allowed metadata is not secret-scanned. | `wire.ts`, `ship-status.ts`, sync attribution envelopes. No new fields. |
| Privacy guarantees | Name hiding is not anonymization; known repo candidates can be tested because the HMAC key is the uploaded install id. Patch IDs contain no diff text but can identify known patches. | `wire.ts:redactIdentity`, `identityMetadata`, `toWireFate`; source-verified, no real private logs read. |
| Attribution certainty | Replace proof-of-identical-work wording with likely patch equivalence; state attribution does not prove causation, time savings or ROI. Costs/energy are estimates, not invoices/measurements. | Stable patch IDs ignore whitespace/line numbers; matching uses repository/time/branch/author evidence. |
| Identity continuity | Cross-machine identity promise now distinguishes canonical remotes from per-install hidden keys. | `wire.ts:redactIdentity`; repo-identity fixtures. |
| Plugin updates | Plugin README now links the live release-pointer blocker instead of promising uninterrupted auto-updates. | Read-only ruleset inspection below. |

[Git's patch-id specification](https://git-scm.com/docs/git-patch-id) was fetched:
it describes likely duplicate detection, not authorship or semantic equivalence.
The security policy is the canonical caution; no new privacy mechanism is claimed.

## #32 interaction and merge order

An isolated detached checkout at #32 accepted #31's source/documentation diff via
`git apply --3way` without conflicts when the generated bundle was excluded. Rebuild
that bundle from combined source; never select one branch's generated file wholesale.
Full combined verification passed locally (695 CLI tests, 258 parser tests, optional
benchmark/parser checks skipped). This is a rehearsal, not a merge or deployment.

Inspected locks, per-tool summaries, memoization and Windows changes directly:

- Main retains live-owner locks and prints no holder details. #32 names the copy,
  pid, origin and start time, heartbeats every 30 seconds, reclaims same-host dead
  holders, and permits reclaim after an hour without heartbeat. Foreign/invalid
  holders retain a 15-minute grace. Windows busy renames retry 20 times at 50 ms;
  exhaustion leaves the lock intact. Existing 24-claimer tests ran locally; Windows
  execution evidence is the existing hosted job, not this Linux run.
- #32 prints per-tool inserted/skipped totals for tools that sent events. These
  count server ingest responses, not tokens, money, coverage or successful git
  attribution. Current main emits per-tool progress but only an aggregate closing
  summary. App onboarding must not promise #32's closing output before release.
- #32 memoizes git facts per common repository directory, default branch, patch-id
  setting, ref/worktree-head/shallow-boundary digest and UTC day. Author identity is
  reread after cache lookup. Facts are still sent; usage overlap is still resent.
  The memo locally stores commit facts including author emails, requests POSIX 0600,
  and does not add upload fields. Windows follows filesystem permissions.
- One wording correction remains on #32: `sync-lock.ts:273–275` says a reclaimed
  same-host holder “is no longer running”, although `abandoned` also accepts an
  alive pid with an hour-old heartbeat. On integration, say the holder is no longer
  running **or has stopped updating its lock**. No behavior defect is established.

Recommended order: land #31 first, then integrate it into #32, update
`docs/integrations.md` lock guidance, add memo/per-tool limits there, correct the
reclaim message, and rebuild/test the bundle. If #32 lands first, rebase #31 onto
it and do the same reconciliation. Neither PR was merged by this review.

## Reproduction and verification

From this repository root:

```sh
npm run verify
node scripts/check-doc-links.mjs
node --test scripts/check-doc-links.test.mjs
npm exec --workspace centrail -- vitest run src/commands/sync.server.test.ts src/commands/connect.test.ts src/commands/integrations.test.ts src/plugin.test.ts
node packages/cli/dist/index.js
node packages/cli/dist/index.js --version
git diff --check
```

Local full gate: 674 CLI tests, 258 parser tests (one optional skip), typecheck,
all builds, 11 server-contract assertions, 17 release checks, packed consumers and
15 comparison-gate tests passed on Linux / Node 24.21.0. The plugin bundle was rebuilt. The focused suite passed 84 tests; all 13 link-checker
regressions passed, and 31 Markdown files / 64 local links resolved.
The refusal regression uses a synthetic HTTP response and a scratch configuration;
no real pairing, upload or installed agent configuration was changed.

For a combined rehearsal, create a detached temporary worktree at the reviewed #32
SHA, apply `git diff origin/main <documentation-head> -- . ':!plugins/centrail/scripts/centrail.mjs'`
with `git apply --3way`, install dependencies, then run `npm run verify` (builds the
bundle). Resolve only source changes and regenerate the bundle. The rehearsal here
used existing local dependencies; it did not publish or install an agent integration.

Read-only live checks were repeated:

```sh
gh api repos/braydenyancy/centrail-cli/rulesets/25045270
gh api repos/braydenyancy/centrail-cli/environments/npm
```

Restrict updates still blocks the release pointer; no bypass actors were returned.
The npm environment still has branch policy only, no required reviewer. No settings
changed. End-user live setup, production uploads and live npm publisher trust were
not exercised. Copilot custom-home scanning, Gemini hook enablement and OpenCode v2
limits remain documented. No new clearly wrong/insecure runtime defect was established.
