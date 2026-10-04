# Changelog

All notable changes are documented here. This project follows semantic
versioning.

## [Unreleased]

### 0.6.0 — sessions outside a repo find their home (decision § 3.9), and an adversarial pass over 0.6
- **Upgrading re-sends your history once, and heavy users will see their
  totals jump.** Every scanner revision is bumped, so each install re-sends
  what is still on disk and the server fills the identity its stored rows
  lack. Measured on a real 198,889-line corpus against every earlier CLI
  (0.2.0–0.5.1): zero duplicate rows. What arrives new is genuinely new:
  subagent transcripts, which 0.5.0 and earlier never read and 0.5.1 crashed
  on past ~125k lines (`push(...)` overflow) — 54,189 requests and 6.28B
  cache-read tokens on that corpus, about 2.5x its rows. Tell users before
  they upgrade that the jump is history, not new usage.
- **A response without a `requestId` is keyed by its message id alone.**
  Gateways (Bedrock, Vertex, proxies) strip `requestId`; the fallback was
  `msg:<message id>:<session>`, so a resumed session's copied responses
  (1,174 on that corpus) would count twice. It is now `msg:<message id>`,
  as `requestId` already folds them. No earlier CLI sent this shape, so
  nothing stored changes.
- **The field policy (decision § 3.10) extends 0.5.1's allowlist, by
  capability.** Every server still gets 0.5.1's usage numbers and nothing
  else. A server that lists `"repo"` also gets, per event, the plaintext repo
  key with its root commit sha and folder label, the placement, the session
  id, the branch and a random install id (`origin.machineId`, a
  `randomUUID`); fate rows gain commit time, line/file counts, `mine`,
  `mergedAs` and the `facts` block. `"usage-extras"` adds speed and
  web-search requests. Every field is named in `wire.ts` and pinned by a
  test that stuffs a parsed event with paths, hostname, platform, account,
  prompt, code, diff and commit-message text and expects exactly the
  allowed keys back. Paths, hostnames, platform, client and account data
  never leave, whatever the server lists; `hideRepoNames` also withholds the
  root sha. Both toggles reach the attribute route too: `repos[]`,
  attributions and fate rows carry the events' `hidden:` key (as their name
  as well) and no branch, so a matching server joins them. Before, they
  reached events only, and the fates' real keys never matched the events'
  hidden ones. Commit shas still go: they are what attribution matches, so a
  hidden public repo can still be found by its commits. A remote that names
  a machine is no longer a key: `alice-macbook.local:/Users/alice/src/x.git`
  keyed as `alice-macbook.local/users/alice/src/x`, and
  `ssh://alice@192.168.1.20/home/alice/…` likewise. IP literals, LAN-only
  names (`.local`, `.lan`, `.home.arpa`, `.localdomain`, `localhost`), home
  paths (`~`) and scp's absolute paths off the forges now key by the root
  sha, which every clone shares.
- **One full re-send on upgrade, so the server can enrich what it holds.**
  Every scanner revision is bumped (claude-code 3, copilot-cli 2, codex 2):
  the first sync after upgrading re-sends each surface's history once, and to
  a server that lists `"repo"` those events carry the repo, placement,
  session, branch and install id that 0.5.1 never sent. The server fills
  missing identity into rows it already holds and never lowers a count. A
  server that starts listing `"repo"` or `"usage-extras"` later gets the
  history once more; a failed pass retries.
- **Placement by touched files, one repo per turn.** A session started in a
  workstream root or the home directory is placed by the files its turns
  touch: the session's cwd if it is a repo, else the turn's edits, else its
  reads (Read/Glob/Grep, Bash absolute paths, Codex `workdir` and patch
  headers), else the session's previous turn, else the folder's own id. A
  turn is placed whole, so totals never split. The Stop hook reads the
  transcript from a per-session byte offset and records the identity of
  every repo a touched path fell under while the folder still exists
  (`transcript_path` in the hook input); the placer runs at sync over the
  same evidence, so a `--full` rescan places identically after the worktree
  is gone. Ships `metadata.placement` next to `metadata.repo`; touched paths
  stay on the machine. The most specific root wins: a turn that edits only a
  submodule is the submodule's whether or not an earlier turn resolved the
  superproject around it (the resolver and the hook took the first known
  root that prefixed a path, so the answer depended on turn order). Sticky
  reaches behind the watermark: an incremental sync reads changed files
  whole and places their earlier turns as context (never sent), so a
  session resumed a day later gives its text-only turn the repo `--full`
  gives, not its folder. The bound: a file unchanged since the watermark is
  not read, so a turn in one (a subagent transcript of that resumed
  session) cannot be the sticky one.
- **Five 0.6 claims fell to their own tests and are fixed.** The
  no-`requestId` fallback id carried the line's timestamp and split one
  gateway response into one event per content block (99.3% of multi-line
  responses differ per line); it is now the message id alone (see the
  resumed-session entry above). A
  remote-less repo's root sha came from `--all`, so a `--single-branch`
  clone of a repo with an orphan branch keyed differently; it is the default
  branch's root. A session in the home directory (or a dotfiles repo checked
  out there) shipped the login as its label; it is `~`. A plain folder
  deleted after its hook line lost its folder id. The hook's throttle was
  silenced by a clock stepped back, and an unwritable sidecar threw.
- **Commit facts ride every fate row** (`committedAt`, line counts; decision
  § 3.8), and against a server that advertises `"match"` the CLI stops
  computing attributions: the server matches every still-unattributed event
  of the repo key to the commits it knows, on any machine, with no window —
  the 8% of tokens that attributed late or never on the reference machine.
- **Attributions follow rewritten history.** Amend, rebase, squash-merge on
  either side, a branch deleted after its PR merged: the fates section now
  goes one call per repo with `facts: { machineId, complete }`, so the server
  can tell which shas vanished and re-match their events to the surviving
  commits instead of leaving them on a ghost sha. Fate rows carry `mine`
  (author is this machine's git identity; the email never leaves) and the
  Stop hook's branch replaces the transcript's `HEAD`, so the server prefers
  your own commits on the session's branch. A stash and a note are not
  history: every `--all` skips `refs/stash` and `refs/notes/*`, so a
  `git stash` no longer becomes unshipped fate rows dated now, and a
  `stash -u`'s untracked-files root commit can no longer become a repo's
  root key.
- **Squash merges resolve, and "shipped" is judged against the remote.**
  A multi-commit branch squash-merged on GitHub, its local branch deleted, its
  stale `origin/<branch>` ref left behind: `git cherry` never saw it, so its
  commits read in flight and kept the events. Fate rows now carry `mergedAs`
  from whole-branch-prefix patch-ids, and ancestry comes from `origin/main`
  when it exists (a parked worktree's local `main` is stale by design). Two
  parallel sessions' racing hooks started four syncs; the throttle is now an
  atomic claim, one sync per interval whatever races.
- **Usage extras carried, priced later.** Fast mode (`usage.speed`) and
  web-search requests are billed differently from tokens; events now carry
  `speed` and `webSearchRequests` to a server that lists `"usage-extras"`.
- **Validated against six other counters** (ccusage, codeburn, tokscale,
  splitrail, claude-monitor, phuryn/claude-usage): equal to splitrail to the
  token on every field, plus the fallback first attempts no other tool counts.
- **The wrappers (§ 4 step 6).** `plugins/centrail` is a Claude Code plugin —
  one `Stop` hook over a bundled copy of this CLI, pinned by the plugin version —
  and Codex reads the same `hooks.json` with a Claude-compatible Stop input, so
  one plugin serves both; the hook stamps the surface from Codex's `turn_id` or
  rollout path and reads a Codex rollout's `shell` workdirs and `apply_patch`
  files as evidence. `centrail install-hooks` also writes Codex's `hooks.json`
  when a Codex home exists. `centrail import <ccusage.json>` sends a
  `ccusage claude daily|session --json` file to the server as Measured-tier
  history (provider `ccusage`), never as certified events.
- **A year of transcripts no longer overflows the scanner.** `push(...perDir)`
  hit the call-stack limit at 177k lines on the reference machine.
- **An incremental sync emits the ids a full scan does.** A `/btw` replay
  folds onto its parent's id only when both are in the scan, and the
  scanner dropped lines before `since` first: a parent on 09-01 and its
  replay on 09-03, synced incrementally on 09-03, became two rows. Files are
  still chosen by mtime; their lines are now folded and collapsed whole and
  filtered after, keeping any response with a line in the window.
- Shared stand-in server for harness tests; 284 CLI and 157 parsers tests.

### 0.5.1 — collection and privacy hotfix
- **Usage upload now has an explicit privacy allowlist.** Absolute paths,
  hostnames, session IDs, provider-account details, and parser metadata remain
  local. Pairing uses a generic device label instead of the OS hostname.
- **Direct and nested subagent transcripts are now scanned.** Claude Code writes
  usage under both `<session>/subagents/*.jsonl` and nested workflow directories.
  A versioned scanner watermark performs the historical backfill automatically
  once after upgrade; no manual `sync --full` is required.
- **Model discovery is forward-compatible.** Claude Code, Copilot CLI, and Codex
  model names pass through from their logs without a model allowlist.
- **Claude streaming snapshots are deduplicated correctly.** For repeated
  request IDs, the CLI keeps the original response and its most complete usage
  snapshot instead of relying on the server to keep whichever record arrives first.
- **An exported `GIT_DIR` / `GIT_WORK_TREE` no longer mis-attributes sessions.** Git
  honours those over `-C <dir>`, so a non-repo directory resolved as a repo; every git
  spawn now runs with the repo-redirecting variables removed.
- **A transcript deleted or rotated mid-scan no longer aborts the whole sync** (the
  Claude scanner had two unguarded reads; Codex and Copilot were already guarded).
- **One sync at a time per machine**, via an owner-aware atomic lock. A live
  long-running backfill keeps its lock; crashed and legacy stale locks recover.
- **Config and watermark files are written atomically** (temp file + rename), so a
  crash mid-write can no longer leave a torn `state.json`.
- **Incremental syncs re-read the trailing 24 hours.** A line can carry a timestamp
  earlier than the moment it reaches disk (long streaming turns, logs synced from
  another machine, clock skew); the server dedupes on `externalId`, so the overlap
  shows up as "skipped", never as a duplicate or a loss.
- **Ship-status fate pass scales with live branches, not commits.** One `for-each-ref`
  plus one `rev-list --since` per branch whose tip is inside the 90-day window,
  instead of `branch --contains` + `merge-base` per sha (≈4,000 spawns per repo).
- Real-git tests for `resolveRepoRoot`: a plain directory, an inherited `GIT_DIR`, and
  a sibling worktree, each against a repo built in a temp dir.

- Added Codex session-log capture from `$CODEX_HOME/sessions` (default
  `~/.codex/sessions`) with per-call token increments, cache accounting, and
  local git commit attribution.
- Extracted from the Centrail monorepo into a standalone public repo.
- CLI now sends `centrail-cli-version` + `centrail-wire` headers (contract v1).
