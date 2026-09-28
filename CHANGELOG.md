# Changelog

All notable changes are documented here. This project follows semantic
versioning.

## [Unreleased]

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
