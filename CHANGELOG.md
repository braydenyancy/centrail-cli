# Changelog

All notable changes are documented here. This project follows semantic
versioning.

## [Unreleased]

### 0.5.1 — collection hygiene (nothing new is sent; the CLI stops losing what it already reads)
- **Subagent transcripts are now scanned.** Claude Code writes subagent usage under
  `<project>/<session-id>/subagents/*.jsonl`; the scanner only read one level deep, so
  every subagent token was missed (29% of all tokens on one agent-heavy machine).
  Run `centrail sync --full` once after upgrading to backfill them.
- **An exported `GIT_DIR` / `GIT_WORK_TREE` no longer mis-attributes sessions.** Git
  honours those over `-C <dir>`, so a non-repo directory resolved as a repo; every git
  spawn now runs with the repo-redirecting variables removed.
- **A transcript deleted or rotated mid-scan no longer aborts the whole sync** (the
  Claude scanner had two unguarded reads; Codex and Copilot were already guarded).
- **One sync at a time per machine**, via an atomic `mkdir` lock in the config dir; a
  second `centrail sync` exits cleanly with "already running". Stale locks from a
  crashed sync are reclaimed after 15 minutes.
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
