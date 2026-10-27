# Security policy

## Reporting a vulnerability

Email **yancy.brayden@gmail.com** with details and reproduction steps. Please do
not open a public issue for security reports. We aim to acknowledge within a few
days.

## What the CLI does and does not do

- It reads local agent usage logs and computes git attribution **locally**.
- It transmits only **allowlisted usage and attribution metadata** (token counts, model names,
  timestamps, repo names, commit metadata) to your configured server.
- It does not extract source code, prompts, completions or credential fields for
  upload. Allowed metadata is not a secret scanner: avoid putting sensitive
  information in repo/branch names, model labels or tool-provided identifiers.
- The auth token is stored at `~/.config/centrail/auth.json`; a revoked
  pairing is retained in `auth.disconnected.json`. Writes request `0600` on
  POSIX. Windows access follows the user profile's filesystem permissions.
- It refuses to send your token over a non-HTTPS connection; plain `http://` is
  permitted only for `localhost`/loopback (local self-hosting and development).

## Upload details

Usage and commit-fate fields pass explicit allowlists in
`packages/cli/src/wire.ts`; attribution request envelopes are assembled in
`packages/cli/src/commands/sync.ts` and `ship-status.ts`. Sync sends:

- an opaque event ID, model, token counts and timestamp per event; the agent
  and the CLI version per sync
- to a server that accepts them: **repo identity** — the canonical remote
  (`github.com/owner/repo`) or, with no remote, the root-commit hash, plus the
  repo's root commit and the folder name as a label — how the repo was chosen,
  the session id, branch and a random per-install id; fast-mode and
  web-search request counts; Pi/Gemini also send a bounded billing-provider
  label and optional service class (evidence of route, not proof of a charge)
- git attribution: repo name or identity, branch, commit SHAs, commit times,
  aggregate line/file counts (including repository size/file totals), whether you authored the commit (your email
  stays local), and the squash commit it landed as; to a server that accepts
  them, a content hash of each commit's change and of its branch so far
  (`git patch-id`), used to match likely equivalent patches after rebases
  or squashes; the hash contains no diff text but can identify a known patch
- for a folder that is not a repo: a keyed hash of the path plus the folder name

Never: absolute paths, machine hostnames, platform details, provider-account details,
source, prompts, completions, diffs, commit messages or credential fields.
Allowed names and identifiers are not scanned for embedded sensitive values. Tool-provided identifiers are used
only as opaque deduplication keys. `centrail inspect --last` prints the last attempted usage-ingest batch, saved
before the request: it does not prove delivery or show earlier batches, pairing,
attribution or commit-fate requests. Two toggles in `~/.config/centrail/config.json`: `hideRepoNames`
(identity ships as a hash, still counted) and `hideBranchNames`, applied to
usage events and git attribution alike. Commit SHAs still go with a hidden
repo (they are what attribution matches), so a public repo's commits can
still be looked up. Hiding names is not anonymization: the hash key is the
install id, also sent with consented events, so a recipient can test candidate
repo names. See the [field contract](CONTRACT.md) for request and response shapes.
