# Changelog

All notable changes are documented here. This project follows semantic
versioning.

## [Unreleased]

### 0.6.0 — sessions outside a repo find their home (decision § 3.9), and an adversarial pass over 0.6
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
  stay on the machine.
- **Five 0.6 claims fell to their own tests and are fixed.** The
  no-`requestId` fallback id carried the line's timestamp and split one
  gateway response into one event per content block (99.3% of multi-line
  responses differ per line); it is now message id + session. A
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
  your own commits on the session's branch.
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
- Shared stand-in server for harness tests; 220 CLI and 115 parsers tests.

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
