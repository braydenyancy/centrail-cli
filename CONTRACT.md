# Wire contract

The CLI (client) and the Centrail server communicate over HTTPS. This document
is the source of truth for that contract.

## Endpoints (server: centrail.org)

- `POST /api/cli/pair` and `/api/cli/pair/poll` — device pairing (`connect`).
- `POST /api/cli/ingest` — push usage events (`sync`). Bearer token required.
- `POST /api/cli/attribute` — push git commit attribution (`sync`). Bearer token.

## Payload types

The CLI converts parser output into a separate, explicit `WireUsageEvent`
allowlist before upload. Local parser metadata and provider-account data are
not part of the wire shape. The server validates its own copy of the untrusted
wire shape, and release CI verifies every exported scanner surface against
that validator before a CLI package can publish.

Usage events contain only `externalId` (opaque deduplication), `model`, token
counts, and `occurredAt`. Optional git attribution is sent separately and may
contain repo basename, branch, commit SHA, and aggregate line/file counts. The
CLI never uploads absolute paths, hostnames, or provider-account identifiers.
It does not upload a separate session metadata field; `externalId` is an opaque
deduplication key and may be derived from identifiers already present in an
agent's usage log.

`ParsedUsageEvent.cacheWriteTokens` is the provider-neutral cache-write bucket.
The older `cacheCreation5mTokens` and `cacheCreation1hTokens` fields remain for
Anthropic's duration-specific billing. `cacheCreationTokens` remains the legacy
aggregate for storage compatibility and must not be added to cost separately.
Servers default a missing `cacheWriteTokens` to zero, so wire version 1 clients
remain valid.

## Capabilities and the identity fields (wire 1, additive)

`GET /api/cli/capabilities` returns `{ wireVersions, surfaces, fields? }`.
`fields` lists optional event fields the deployed server accepts beyond the
base shape. The CLI reads it once per sync; unreachable or absent means the
0.5 shape exactly.

When `fields` contains `"repo"` the CLI sends, per event:

- `metadata.repo: { key, label, source }` — `key` is `host/owner/repo`
  (canonical remote, lowercase, `.git` stripped), `sha:<root commit>` (no
  remote), `dir:<hmac>` (not a repo), or `hidden:<hmac>` when the user set
  `hideRepoNames`; `label` is the folder basename (empty when hidden);
  `source` is `remote | root | folder`.
- `metadata.placement: "cwd" | "files" | "sticky" | "folder"` — how `repo`
  was chosen, sent with it (0.6.0, decision § 3.9): the session's folder is
  inside the repo; the turn's touched files named it (edits, then reads,
  then Bash paths); the session's previous turn was placed there; or it is
  the folder's own `dir:` id. The tag is the disclaimer next to the
  identity; a server may weight or filter on it and must accept its
  absence. The touched paths themselves never leave the machine.
- `metadata.origin.machineId` — random per-install uuid.
- and **omits** `metadata.cwd` and `metadata.origin.host`. A server that
  advertises `"repo"` must therefore accept `origin` without `host`, and key
  Inbox grouping and rules on `repo.key`, not `cwd`.

Attribution and fate rows gain `repoKey` next to `repoName`; `repos[]` gains
`key`. `repoName` stays the display label. Several checkouts of one repo
carry one `key` and possibly different labels; the server picks one label
per key.

**Commit facts on fate rows, and `"match"` (0.6.0, decision § 3.8).** Every
fate row now carries the commit's facts: `committedAt` (ISO), `linesAdded`,
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
usage on every content block and `output_tokens` grows across them). A
server that previously stored the first line for a request should upsert
`output_tokens = GREATEST(existing, incoming)` on conflict so the 24 h
overlap re-send corrects rows inserted mid-stream. Events without an
Anthropic `requestId` (gateways) arrive with
`externalId = "msg:<message id>:<session id>"` — never the timestamp, which
differs per content block of one response.

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

- `centrail-cli-version` — the CLI's package version (informational).
- `centrail-wire` — the **contract version** (currently `1`).

Rules:

- Adding optional fields does **not** bump `centrail-wire`.
- A breaking payload change bumps `centrail-wire`. The server supports the
  **current and previous** contract versions during a deprecation window.
- Requests older than the previous version receive `426 Upgrade Required` with
  guidance to run `npm i -g centrail@latest`.

> Self-hosting: because the client is open and this contract is documented, you
> can point the CLI at your own server with `centrail connect --url <base>`. This
> is possible but not an officially supported product.

## Release ordering

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
(`centrail inspect --last`) against a server advertising `fields: ["repo"]`.
The server repo carries a copy under its wire tests and parses it; when the
shape changes, regenerate this file from a real sync and update both.
