# Package releases

The app deploys from `main` through Vercel independently. Merging CLI code prepares a release;
`centrail sync` uploads usage and never publishes or installs the CLI.

```mermaid
flowchart LR
  M[Product main] --> R[Reviewed release PR: versions, changelog, bundle]
  R --> T[Immutable v* tag]
  T --> C[Read-only tests, contract and packed consumers]
  C --> N[npm environment: v* tags only, OIDC]
  N --> P[Verify exact published tarballs]
  P --> B[Stable plugin release branch]
```

1. Merge product PRs with Conventional Commit titles. Release Please proposes versions and
   notes for `feat`/`fix`; test/docs/chore-only work does not trigger an unnecessary release.
2. Review the release PR's coordinated CLI/parser versions, Claude/Codex metadata, marketplace,
   changelog and rebuilt bundle. Require platform checks and parser comparisons before merge.
3. Merging that release PR creates an immutable `v*` tag. The workflow explicitly dispatches
   publication at the tag ref because GitHub suppresses token-created tag push events.
4. Read-only CI tests the tagged code and deployed server contract, then retains tested tarballs.
   Publication then runs automatically in the `npm` environment through OIDC; it installs no
   dependencies and runs no build or tests. The reviewed release PR is the human gate.
5. Publish parsers before CLI, verify both registry tarballs against retained bytes, then advance
   the stable plugin's `release` branch. That branch is an update pointer, never a publish trigger.

Stable versions use npm `latest`; prereleases use `next` and leave the stable plugin unchanged.
A prerelease needs a reviewed version PR first. Tags must match coordinated versions on main.
Publishing uses GitHub-hosted Node 24/npm 11.5.1+; installed CLI support remains Node 20+.

For interruption recovery, rerun the failed tag workflow or dispatch `publish.yml` at that
existing tag. Matching immutable versions are verified and reused; mismatches fail. Never
recreate a published tag/version or move a channel backward. This process does no historical
repricing. Users upgrade their installation, then normal sync replays eligible local history.

## One-time owner settings

- Enable GitHub Actions to create pull requests. GitHub combines creation and approval in
  one checkbox; this workflow creates PRs and leaves approval to humans. Require green main checks.
- Protect published `v*` tags against updates and deletion, and restrict their creation to
  GitHub Actions (release-please creates them).
- Protect branch `release` (ruleset: restrict updates, restrict deletions, block force pushes;
  bypass GitHub Actions only). Installed plugins auto-update from it and run its Stop hook on
  every turn, so only the publish workflow may advance it, after npm verification.
- On npm, set both packages to **Require two-factor authentication and disallow tokens**;
  trusted publishing keeps working and nothing else can publish.
- Environment `npm`: deployment policy **type tag**, pattern `v*` (a branch rule with that
  text does not admit version tags). No required reviewers: merging the reviewed release PR
  publishes end to end (decided 2026-10-14; a second click by the same person added no review
  and was easy to miss). Only `v*` tags created from reviewed main can reach npm trust.
- Configure trusted publishing for **both** `centrail` and `@centrail/parsers`: owner
  `braydenyancy`, repository `centrail-cli`, workflow `publish.yml`, environment `npm`.
  Allow direct `npm publish` and `npm dist-tag`. No long-lived npm token fallback is used.
- Create fresh npm trust shortly before publication; first use currently must be within two days.
  Verify OIDC works before retiring old automation tokens.
- Keep the repository public and package repository metadata aligned for provenance.

Owner settings and a real publication require external verification; local checks do not prove them.
The manifest records the last release and advances through the reviewed release PR.
Local development identifiers do not reserve npm versions; the receipts record the first proposal.

Run `npm run verify`; optional SDK commands are in [verification](verification.md).
Receipts: [actual SDK rehearsal](verification/release-automation-2026-10-12.json),
[toolchain verification](verification/release-toolchain-2026-10-12.md).
Sources: [Release Please](https://github.com/googleapis/release-please-action),
[GitHub event triggering](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow),
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
