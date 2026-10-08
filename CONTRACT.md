# Wire contract

The CLI (client) and the Centrail server communicate over HTTPS. This document
is the source of truth for that contract.

## Endpoints (server: centrail.org)

- `POST /api/cli/pair` and `/api/cli/pair/poll` — device pairing (`connect`).
- `GET /api/cli/device` — this token's own pairing (`sync`, `status`). Bearer token.
- `POST /api/cli/ingest` — push usage events (`sync`). Bearer token required.
- `POST /api/cli/attribute` — push git commit attribution (`sync`). Bearer token.
- `GET /api/cli/capabilities` — what the deployed server accepts, and the CLI
  versions it ships and accepts (`sync`). No token.

## Pairing and the token's health (0.6.1, additive)

One machine holds one pairing (`auth.json`). `POST /api/cli/pair` takes
`{ hostname, installId? }`: `hostname` is the fixed label `Centrail CLI`, never
the machine's name, and `installId` is the random per-install id, sent only by
an install that has answered the scope question (§ 3.7; it is the same id
events carry as `metadata.origin.machineId`). With it, approving replaces this
install's own device in place instead of taking another slot, and approving
as a different account moves the machine there, revoking the old account's
device for it. A server that learns an install id from a device's consented
events records it, so a first pairing (sent without one) is matched later.
Older servers ignore the field.

**One provider event, one account (decision A, 2026-10-07).** A machine that
moves keeps its history where it was synced. The CLI forgets its watermarks
whenever the account may have changed (`connect`), so the first sync after
re-sends everything still on disk; the server stores an event only for the
first account that synced its `externalId` and skips it for any other. The
ingest response counts those as `heldElsewhere` (never naming the account),
inside `skipped`, which is events − inserted:
`{ inserted, skipped, updated, inboxCount, heldElsewhere }`. The CLI sums it
across batches and, when it is above zero, prints it on its own line and
reports `skipped` without it. Older servers omit it (read as 0).

The approved poll answers `{ status: "approved", token, account?: { email } }`;
the CLI stores the email for display only.

`GET /api/cli/device` answers `200 { account: { email }, device: { name,
pairedAt } }` for a working token. Every bearer route refuses a dead one with
`401 { error, code }`: `code` is `"device_revoked"` (replaced from another
machine or revoked in Settings) or `"unknown_token"` (no such pairing: never
issued, or the account was deleted); `error` stays for older clients. The CLI
asks before it scans, so a dead token is caught even when nothing is new; a
server without the route (404), an outage or a timeout is read as unknown and
the sync goes on. On any 401 the CLI moves `auth.json` to
`auth.disconnected.json` with the reason, so the Stop hook stops starting
syncs, and every later command says why until `connect` pairs again.

## Payload types

The CLI converts parser output into a separate, explicit `WireUsageEvent`
allowlist before upload. Local parser metadata and provider-account data are
not part of the wire shape. The server validates its own copy of the untrusted
wire shape, and release CI verifies every exported scanner surface against
that validator before a CLI package can publish.

To every server, usage events contain only `externalId` (opaque
deduplication), `model`, token counts, and `occurredAt` — the 0.5.1 allowlist,
`toWireUsageEvent` in `packages/cli/src/wire.ts`. Each ingest body names its
`source.surface` (which agent), and every request carries the CLI version
header. Optional git attribution is sent separately and contains the repo
basename, branch, commit SHA, and aggregate line/file counts. A server that
lists capability fields receives the additions below, each named in the same
module (decision § 3.10); nothing reaches the wire by spreading a parsed
event, and `packages/cli/src/wire.test.ts` pins the exact keys.

Never uploaded, to any server: absolute paths or working directories,
hostnames, platform details, provider-account data (email, account or org
ids), prompts, completions, source code, diffs, commit messages, or any
encrypted blob a tool stores. `externalId` may be derived from identifiers
already present in an agent's usage log (a Codex request id embeds its
session id).

`ParsedUsageEvent.cacheWriteTokens` is the provider-neutral cache-write bucket.
The older `cacheCreation5mTokens` and `cacheCreation1hTokens` fields remain for
Anthropic's duration-specific billing. `cacheCreationTokens` remains the legacy
aggregate for storage compatibility and must not be added to cost separately.
Servers default a missing `cacheWriteTokens` to zero, so wire version 1 clients
remain valid.

## Capabilities and the identity fields (wire 1, additive)

`GET /api/cli/capabilities` returns `{ wireVersions, surfaces, fields?, cli? }`.
`fields` lists optional event fields the deployed server accepts beyond the
base shape; `cli: { latest?, minimum }` is the CLI-version floor (§
Versioning). The CLI reads it once per sync. Absent, or never answered, means
the 0.5.1 shape exactly; a server that answered before and cannot be asked now
is taken at its last answer, so a flaky route never strips identity.

The user's scope answer (decision § 3.7) gates all of it. Until the install
has answered the scope question (`connect`, `setup`, `install-hooks`, or the
first `sync` run in a terminal), the CLI treats `fields` as empty on every
route, whatever the server lists: ingest bodies, attributions and fate rows
are the 0.5.1 shape exactly, and the CLI matches commits itself. An install
upgraded from 0.5.x starts unanswered. Its answer re-sends the whole history
once with the fields the server lists, as a widened scope does, and the
server fills the identity into the rows it already holds (below).

When `fields` contains `"repo"` the CLI sends, per event, a `metadata` object
with exactly these keys (each absent when unknown):

- `metadata.repo: { key, label, source, root? }` — `key` is `host/owner/repo`
  (canonical remote, lowercase, `.git` stripped), `sha:<root commit>` (no
  remote, or one that names a machine: an IP literal, a LAN-only name, a
  dotless host such as an ssh alias, a home or absolute scp path),
  `dir:<hmac>` (not a repo), or `hidden:<hmac>` when the user set
  `hideRepoNames`; `label` is the folder basename (empty when hidden);
  `source` is `remote | root | folder`; `root` is the default branch's root
  commit sha, sent with remote and root keys so the server can propose
  merging two keys of one renamed or transferred repo, and withheld under
  `hideRepoNames`.
- `metadata.placement: "cwd" | "files" | "sticky" | "folder"` — how `repo`
  was chosen, sent with it (0.6.0, decision § 3.9): the session's folder is
  inside the repo; the turn's touched files named it (edits, then reads,
  then Bash paths); the session's previous turn was placed there; or it is
  the folder's own `dir:` id. The tag is the disclaimer next to the
  identity; a server may weight or filter on it and must accept its
  absence. The touched paths themselves never leave the machine.
- `metadata.sessionId` — the agent's session id, plaintext.
- `metadata.gitBranch` — the session's branch (the Stop hook's branch when the
  transcript says `HEAD`); absent under `hideBranchNames`.
- `metadata.origin: { machineId }` — a random per-install uuid, minted once
  (`crypto.randomUUID`), derived from nothing on the machine. `origin`
  carries nothing else: no `host`, `platform`, `client` or `clientVersion`.
  A server that advertises `"repo"` must accept `origin` with `machineId`
  alone, and key Inbox grouping and rules on `repo.key`.

Without `"repo"` none of these are sent and the body is the 0.5.1 shape.

Attribution and fate rows gain `repoKey` next to `repoName`; `repos[]` gains
`key`. `repoName` stays the display label. Several checkouts of one repo
carry one `key` and possibly different labels; the server picks one label
per key. The toggles apply here as on events: under `hideRepoNames` the key
is the events' `hidden:<hmac>` and the name is that same key (never empty,
never the folder); under `hideBranchNames` every row's `branch` is `null`. The fate-row additions below (commit facts, `mine`, `mergedAs`, the
`facts` block) also go only to a server that lists `"repo"`; to any other a
fate row is `{ repoName, commitSha, branch, fate }`.

**Commit facts on fate rows, and `"match"` (0.6.0, decision § 3.8).** Every
fate row to a `"repo"` server carries the commit's facts: `committedAt` (ISO), `linesAdded`,
`linesDeleted`, `filesChanged`. When `fields` also contains `"match"`, the
server attributes this user's still-unattributed events of each `repoKey` to
those commits itself (earliest commit at or after the event, the same rule
the CLI used, with no window), and the CLI sends **no** `attributions[]` —
it declares `repos[]` with the first `fates` call instead. Without `"match"`
the CLI attributes as before and the facts ride along unused. Matching is
per user: another member's commit never absorbs your tokens by time alone.

**Attributions follow the facts (0.6.0).** Each fate row may carry `mine`
(the commit's author is this machine's git identity; the address never
leaves), and the fates section is sent **one call per repo**, declaring only
that repo, with `facts: { machineId, complete }` at the top level —
`complete` is false when the repo hit the 2000-sha cap. From a complete set
the server can tell which shas vanished since the same machine last
reported (amended, rebased, squashed, branch deleted), drop their
attributions and re-match those events; it prefers, among commits at or
after an event, one that is `mine` on the event's `gitBranch`, then `mine`,
then the branch, then the earliest. `gitBranch` is the session's real branch
from the Stop hook when the transcript says `HEAD`. Older servers ignore
`facts` and `mine`.

**One event per request.** The CLI now collapses the transcript lines of one
request to one event holding the per-field maximum (Claude Code re-stamps
usage on every content block and `output_tokens` grows across them), at the
timestamp of its first line. A sidechain replay that shares a request id
never adds to the original, and a `/btw` replay under a new request id takes
its parent's; an incremental scan folds whole files before it filters by
time, so it emits the ids a full scan does. A server that previously stored
the first line for a request should upsert `output_tokens = GREATEST(existing,
incoming)` on conflict so the 24 h overlap re-send corrects rows inserted
mid-stream. Events without an Anthropic `requestId` (gateways) arrive with
`externalId = "msg:<message id>"` — never the timestamp, which differs per
content block of one response.

**One full re-send on upgrade (0.6.0).** Every scanner's revision is bumped
(`SCANNERS[].revision`), so the first sync after upgrading re-sends each
surface's whole history once. Against a `"repo"` server, once the scope
question is answered, those events carry the identity metadata above (an
install that answers later re-sends them then), so the server can enrich rows
it already holds:
fill identity fields a row lacks (`repo`, `placement`, `sessionId`,
`gitBranch`, `origin.machineId`) and keep token counts at
`GREATEST(existing, incoming)` — a re-send never lowers a count, never adds a
row, and never overwrites identity the row already has. Older servers dedupe
the re-send on `externalId`, as they do the 24 h overlap. A server that
starts listing `"repo"` or `"usage-extras"` after an install has synced gets
the history re-sent once more, the way a widened scope does, so an install
that upgraded before the server deployed is enriched when it does.

**Squash merges (0.6.0).** A fate row may carry `mergedAs: <sha>`: the
default-branch commit whose patch equals this sha's branch prefix from its
merge base — a multi-commit squash merge, which `git cherry` cannot see.
Such a row is `shipped`; the server excludes the sha from matching, moves
its attributions to `mergedAs`, and rolls it up under that commit. "Shipped"
is judged against `origin/<default>` when the checkout tracks one, so a
worktree parked detached at `origin/main` reads correctly.

**Patch ids, and `"patch-id"` (0.6.0, decision § 3.10).** When `fields`
contains `"patch-id"`, a fate row may carry two content hashes, each
`git patch-id --stable` (40 hex), computed with pinned diff options (no
rename detection, myers, quoted paths) so two machines agree:

- `patchId` — the commit's own diff against its first parent. Absent for a
  merge commit (its first-parent diff is the merged side's work, which
  those commits already carry: matching on it would let the merge stand in
  for work it only brought in) and for a root commit (no parent: its "diff"
  is the whole initial tree, which unrelated scaffolds share).
- `branchPatchId` — the cumulative diff from the commit's merge base with
  the default branch (the ref "shipped" is judged against) up to the
  commit: what a squash of the branch **up to this commit** carries, so a
  squash of any prefix is matchable. Each commit's own merge base: after a
  branch merges the default branch in, the commits before that merge keep
  the older base. Absent for commits on the default branch, and past the
  newest 50 commits of a branch.

A vanished sha's events may then move to a live commit only on proof: its
`patchId` equals the live commit's (a rebase, a cherry-pick, a reworded
amend), or its `branchPatchId` equals a default-branch commit's
`patchId` (a squash merge, even with the branch deleted). Neither field
reveals code; they are sent with or without `"repo"`, once the scope question
is answered. Without `"patch-id"` fate rows are exactly as above.

**Usage extras (0.6.0).** When `fields` contains `"usage-extras"`, an event may
carry top-level `speed` (Claude's `usage.speed`, e.g. `"standard"` or `"fast"`)
and `webSearchRequests` (a positive integer from
`usage.server_tool_use.web_search_requests`); absent when the transcript has
none. Both are priced differently from tokens; the server stores them and prices
them when it chooses to. Never sent to a server that does not list the field.

**Import (0.6.0, outside wire 1).** `centrail import <file>` POSTs
`{ provider: "ccusage", rows: [{ day, model, inputTokens, outputTokens,
contextTokens }] }` to `POST /api/import` with the device token; the server
accepts that token as it accepts a signed-in session, stores the rows in the
imported (Measured) table with replace-per-provider semantics, and never
mixes them with certified events. `contextTokens` is cache read + cache
creation. A `session --json` file lands each session on the UTC day of its
last activity.

## Versioning

Every request carries two headers:

- `centrail-cli-version` — the CLI's package version.
- `centrail-wire` — the **contract version** (currently `1`).

Rules:

- Adding optional fields does **not** bump `centrail-wire`.
- A breaking payload change bumps `centrail-wire`. The server supports the
  **current and previous** contract versions during a deprecation window.
  Only wire `1` has ever existed.

**The CLI-version floor (decision B, 2026-10-07).** Capabilities carry
`cli: { latest?, minimum }`: `latest` is npm's `latest` dist-tag (absent when
the server could not read npm), `minimum` the oldest `centrail-cli-version`
the server accepts. `POST /api/cli/pair`, `/api/cli/ingest` and
`/api/cli/attribute` refuse a version below `minimum` with
`426 { error, code: "cli_outdated", minimum }`, before the token is checked,
so an outdated install is never mistaken for a revoked one. The 426 is an
application-version refusal, not a protocol switch, so it carries no `Upgrade`
header; the body's `code` is the signal. A missing or
malformed version header is never refused; the pair poll, `GET
/api/cli/device` and `/api/import` are not gated. The CLI ignores fields it
does not know or that do not parse as versions, as it ignores a server
without `cli`. What it does with them (`packages/cli/src/update.ts`):

- **Behind `latest`:** one line on stderr after a sync, only when stderr is a
  terminal (the gate progress uses), naming the command that updates the
  copy that ran. A sync the Stop hook started keeps it in `state.json` and
  `centrail status` prints it; the copy's next sync at `latest` clears it.
- **Below `minimum`, or any 426:** no scan (when capabilities already say
  so) and no further writes; one line naming the minimum and the update
  command; `state.json` records the refused version, and the Stop hook of
  that version starts no syncs until it runs another version. The token stays
  in `auth.json`. A sync by hand asks again, and a server that accepts it
  lifts the park. `connect` reports a 426 on pairing the same way.

**Update channels.** The CLI never installs itself; it detects how the
running copy was installed, from where its script lives: the Claude Code
plugin bundle (`scripts/centrail.mjs`, or under `CLAUDE_PLUGIN_ROOT`) "updates
through Claude Code (/plugin)"; the npx cache (`_npx`) `npx centrail@latest`;
mise's npm backend `mise upgrade npm:centrail`; a global npm prefix
`npm i -g centrail@latest`; anything else a generic line. The plugin is the
primary hook path: its marketplace is pinned to the `release` branch, which
`publish.yml` fast-forwards to each tag after `npm publish` succeeds, and
`connect` (in a terminal, asked once; `centrail setup-plugin` asks again)
sets `autoUpdate: true` on `extraKnownMarketplaces.centrail` in the user's
Claude Code settings, the switch Claude Code reads for third-party
marketplaces. Claude Code notices an update by the plugin's `version`, which
every release bumps.

> Self-hosting: because the client is open and this contract is documented, you
> can point the CLI at your own server with `centrail connect --url <base>`. This
> is possible but not an officially supported product.

## Release ordering

### Local hook ownership (0.7.4 candidate)

Claude Code's plugin owns its shell launcher and may rely on Claude's
`CLAUDE_PLUGIN_ROOT` contract. Codex owns an explicit user hook installed by
`install-hooks`, pinned to absolute Node and CLI bundle paths. The processing
core accepts both Stop inputs; launchers and output contracts are separate.
`--surface codex` selects the Codex fallback surface and emits an empty JSON
object on stdout, including for malformed input; Claude's launcher stays silent.
`--centrail-hook` marks newly emitted standalone commands for conservative
cleanup even at a custom installation path. Explicit installation from the
plugin bundle is refused before scope/setup or hook-settings writes, preventing
a pinned Codex command from depending on Claude's replaceable cache.
These switches change no wire fields.

The plugin's Codex compatibility manifest explicitly supplies empty inline
hooks, suppressing default `hooks/hooks.json` discovery. `setup-plugin` writes
only Claude's user configuration. `install-hooks` replaces identifiable legacy
Centrail handlers individually, removes obsolete standalone Claude handlers when
the user plugin is enabled, and preserves unrelated handlers and group metadata.
Uninstall owns the same user files and never uninstalls a harness-managed plugin.
Unattributed generic plugin-root launchers, project/managed/inline TOML entries
and stale plugin caches require review through their owning harness; no global
exactly-once guarantee can be made while an independent registration remains.

Existing pinned Codex entries must be reinstalled to receive the Codex output
switch; a bundle update alone does not edit hook settings. Changed definitions
need Codex trust review and sessions need reload/restart. Pinned Node/bundle
paths must be refreshed after they move. Windows Codex uses its native command
runner and needs no `sh`; Claude's shell plugin still requires Claude's Git Bash
environment on Windows. With no Git on PATH, the pinned command can record a
folder/session but cannot resolve repository identity. No migration, forced
historical scan or server rollout is required for this local hook change.

### Server/CLI sequence

A new scanner surface (or wire change) touches both repositories. The order is
fixed — the server must accept a payload before any published CLI can send it:

1. **Server first.** Land and deploy the centrail change (ingest allowlist,
   wire fields, `/api/cli/capabilities`). The capabilities endpoint is the
   deployed source of truth this repo's CI checks against.
2. **CLI second.** Merge the CLI change. The contract check in PR CI is
   **advisory** (`continue-on-error`): a red check on a PR means the server
   side has not deployed yet, or centrail.org was unreachable — it must not
   block development.
3. **Tag last.** Push a `v*` tag only when the contract check is green. The
   publish workflow re-runs the same check against production and **fails
   closed** — nothing reaches npm unless the deployed server accepts every
   scanner surface at the current wire version.

Escape hatches for the check itself: `CENTRAIL_CONTRACT_URL` points it at a
staging deployment; `CENTRAIL_CONTRACT_ATTEMPTS` bounds the retry loop.

## Wire samples

`wire-samples/ingest-0.6.json` is a real ingest body captured from the CLI
bundle against a server advertising `fields: ["repo", "match", "patch-id"]`,
and `attribute-0.6.json` the fates calls of the same sync: the root commit
with no patch id, a default-branch commit with `patchId` only, and the
worktree branch's commit with `patchId` and `branchPatchId`.
The server repo carries a copy under its wire tests and parses it; when the
shape changes, regenerate this file from a real sync and update both.
