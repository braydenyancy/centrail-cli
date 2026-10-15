# Documentation review — 2026-10-15

Reviewed the 29 pre-existing Markdown files (including hidden GitHub templates),
three package descriptions, plugin metadata, command usage/output strings and four
workflow files against the checked-out 0.9.0 implementation. Historical prose and
CHANGELOG remain historical; seven dated narratives now point to current guidance.

Canonical homes: README for user entry and scope, integrations for agent lifecycle,
CONTRACT for wire fields, releases for publication, verification for repeatable checks.
The npm README uses absolute source links because repository-relative paths outside
the package do not survive publication.

## Claim inventory

Rows group related factual claims, not individual sentences. Status is the initial
finding; corrected rows below are fixed by this review. Counts: 9 stale, 5 wrong,
2 duplicated, 8 missing, 5 correct (29 groups).

| Claim group / surface | Finding | Evidence / disposition |
| --- | --- | --- |
| Root README Pi/Gemini release status | stale | Scanner registry and 0.9.0 package metadata; remove unreleased label |
| Parser README release status | stale | Published parser package includes both readers |
| Three package descriptions' agent list | stale | `packages/parsers/src/index.ts`; include Gemini/Pi |
| Plugin description's two-source list | stale | Sync runs the scanner registry; describe supported sources |
| Noninteractive connect hint named only two agents | stale | Setup supports five usage agents; correct user-facing hint and rebuild bundle |
| Contributor CLI command subset | stale | `packages/cli/src/index.ts`; link current command guide |
| Verification's proposed 0.8.0 wording | stale | Dated rehearsal remains a proposal; label it historical |
| Seven dated narratives read as current | stale | Add current-guide pointers; preserve original receipts |
| Workflow's publication-approval step name | stale | `npm` environment now has branch policy only; rename text |
| Root README said no new Pi/Gemini hooks | wrong | `commands/agent-hooks.ts` installs both |
| CONTRACT said new sources install no hooks | wrong | Separate scanner consent from setup lifecycle |
| All hooks claimed touched-file attribution | wrong | `commands/hook.ts`: only Claude/Codex transcripts supply paths |
| README said upgrade runs every channel updater | wrong | `commands/upgrade.ts` only runs npm/mise; npx/plugin explain next action |
| Security called metadata non-sensitive / 0600 universal | wrong | `wire.ts`, `config.ts`: identity metadata, POSIX mode vs Windows permissions |
| Root README repeated integration installation detail | duplicated | Keep lifecycle details in `docs/integrations.md` |
| npm README repeated pricing/product promises | duplicated | Replace claims with the current pricing page and CLI facts |
| Persistent npm/mise and Windows entry paths | missing | Launcher/install-channel implementation; add installation choices |
| Uninstall retained pairing/package and fallback limits | missing | `runUninstall` preserves pairing/logs, needs Claude for plugin removal |
| Copilot custom-home scanner limitation | missing | `providers/copilot-cli.ts` uses default home; hook uses `COPILOT_HOME` |
| Gemini global hook settings untouched | missing | `commands/agent-hooks.ts` changes owned entries only |
| Lock-holder diagnostics and safe retry | missing | `config.ts` owner liveness, 15-minute ownerless grace; no holder/age output |
| Release pointer block vs intended policy | missing | GitHub ruleset 25045270 still has update restriction, no bypass |
| Registry propagation and excluded-path override | missing | `release-policy.mjs`, `release-please-config.json`; document bounded polls and Release-As |
| Python prerequisite in default verification | missing | `verify.mjs` runs `test:comparison-gate`, which invokes `python3` |
| Help commands, flags and deprecated aliases | correct | Compare built CLI usage with `src/index.ts` dispatch |
| Agent paths, event names, launcher and doctor schema | correct | `agent-hooks.ts`, `integrations.ts`, `launcher.ts`, `doctor.ts` and fixtures |
| Consent, capabilities, privacy and replay | correct | `wire.ts`, sync suites, parser and real-git fixtures; add billing-route disclosure |
| Versions and release gates | correct | 0.9.0 coordinated metadata; workflow and release-policy tests |
| Comparison corpus/provenance and conduct/issue policies | correct | Fixture manifest, comparator implementation and retained dated evidence; no runtime mismatch found |

## Repeatable evidence

From the repository root after `npm ci`:

```sh
npm run verify
node scripts/check-doc-links.mjs
node --test scripts/check-doc-links.test.mjs
npm exec --workspace centrail -- vitest run src/commands/connect.test.ts src/plugin.test.ts
node packages/cli/dist/index.js --version
node packages/cli/dist/index.js
git diff --check
```

The full verification passed on Linux / Node 24.21.0: 673 CLI tests, 258 parser tests
(one optional parser control skipped), 11 server-contract assertions, 17 release
checks and 15 comparison-gate self-tests. Builds, typecheck and both packed 0.9.0
consumers passed; the committed runtime bundle changes only the corrected connect hint. Version prints
`centrail 0.9.0`; no-argument usage matches the command guide. After correcting
the connect hint and rebuilding, the focused connect/plugin suite passed 22 tests.
Tests exercise setup,
upgrade/uninstall, per-agent files, noninteractive consent and real hook subprocesses
in scratch homes; no real pairing, upload, package update or agent config was changed.

`node scripts/check-doc-links.mjs` passed: 30 Markdown files, 61 local links and
anchors, zero failures; all 13 checker regression fixtures passed. The checker validates repository-local targets; external
URL checks remain the separate spot checks below.

Initial sandbox execution failed because shell/git subprocesses and local HTTP
listeners were restricted; the permitted rerun passed. This is Linux evidence,
not a fresh macOS/Windows run. Optional live Codex and competitor executions were
not requested for this documentation-only change; their fixture checks ran.

Read-only GitHub checks on 2026-10-15:

```sh
gh api repos/braydenyancy/centrail-cli/rulesets/25045270
gh api repos/braydenyancy/centrail-cli/environments/npm
```

The pointer rules are deletion, non-fast-forward, update and required signatures,
with no bypass actors. The npm environment has a branch policy and no required
reviewers. These checks changed no settings. External spot checks fetched
[Release Please's version override](https://github.com/googleapis/release-please#how-do-i-change-the-version-number)
and [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/). The unsupported
fixed two-day trust deadline was removed in favor of npm's current setup guidance.

## Open decisions and limits

No new clearly wrong/insecure code was established by this review. Existing open
limits remain explicit in [troubleshooting](../integrations.md#uninstall-and-troubleshooting):
Copilot custom-home scanning, Gemini hook enablement, lock diagnostics, OpenCode v2,
and the release-pointer ruleset. The planned organization move and calculations'
second publication gate require owner decisions; neither settings nor owners changed.

Auth-atlas boundary reviewed: estate atlas §2 maps dvoid login/OpenBao and CI
provisioning; Centrail pairing and npm publishing use separate product/external
verifiers. No mapped estate authentication flow changes here.
