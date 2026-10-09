# Tokscale review implementation — October 2026

Local implementation; no push, release, deployment or historical cleanup. The
[initial review](../../centrail/docs/decisions/2026-10-tokscale-review.md) identified
collection failures and useful source-format coverage. This implements the bounded
collection and comparison recommendations, retaining Centrail's consent, account
isolation and explicit uncertainty.

## Collection and new sources

Modified source files replay their complete valid history through existing scope
checks and idempotent ingestion. Earlier events still participate in repository
placement; their old timestamp no longer prevents delivery. Discovery considers
file change time as well as modification time, including copies with preserved
modification time. Existing scanner revisions trigger one recovery backfill.

Codex and Copilot copies deduplicate by source evidence rather than allocating a
new identity for each file. Contradictory copies are quarantined visibly. Codex
same-timestamp calls retain distinct identities; fork suppression requires matching
parent evidence rather than blindly discarding a parent-length prefix or a fast
burst. Without parent evidence, replay can remain uncertain. Removing a local file
does not delete stored usage. Previously ingested erroneous duplicate suffixes are
not cleaned up, and the existing growth-only ingest cannot apply downward token
corrections.

Pi and Gemini CLI join the existing scanner registry and sync invocation. The sync
upload pass reads them only after the scope answer and a server advertising both
their surface and `billing-route`. Setup and repository discovery may read them
locally to show the scope before approval; this does not upload their contents. No new Pi/Gemini lifecycle hooks are installed. OpenCode,
Hermes aggregates, and Pi-derived products without their own compatibility fixtures
remain future work.

Pi preserves disjoint input/output/cache buckets, stable source-derived identity,
and explicit one-hour cache detail. Unknown cache duration stays incomplete;
five-minute duration is not guessed. Gemini preserves message identity, separates
cached prompt input, adds observed thoughts to output only when total accounting
agrees, and quarantines nonzero tool-prompt usage whose overlap is unresolved.
Malformed counters and unsafe identifier strings are rejected. Absolute local paths, source text,
titles, responses, credentials and arbitrary provider labels do not enter uploads.

## Billing and session identity

`billingProvider` is bounded source evidence, not proof that an API charge occurred.
For example, Pi's `anthropic` provider also supports Claude subscription OAuth.
Model-based amounts are list-price estimates, not an actual invoice or subscription
allocation. Custom/routed providers and unknown or nonstandard tariffs remain
unpriced; Gemini's transcript cannot establish the API versus OAuth billing route,
so its outbound billing provider is `unknown`. Legacy Claude/Codex/Copilot route
behavior is unchanged and needs its own deliberate reconciliation.

Session IDs were already sent in plaintext after the scope answer when the server
advertises `repo`, and stored through a bounded server allowlist. This work preserves
that policy: Pi uses `pi:` and Gemini uses `gemini:` prefixes to separate source
namespaces. Hiding repo/branch names does not remove session identity. There is no
new hash migration. IDs are correlation metadata; a copied provider event currently
has one retained session association, not a many-to-many session analytics model.
Equal token totals alone never establish identity across different harness formats.

The server retains bounded route metadata, preserves account-local copies and
frozen pricing evidence during growth, and labels newly paired sources `Centrail
CLI`. Existing custom or historical labels are not rewritten. The calculation
registry remains separate and is not activated by these changes.

## Evidence

The follow-on [comparison suite](../tools/tokscale-compare/README.md) now adds
pinned ccusage and Claude Code Usage Monitor, a shared corpus, reviewed baselines
and failing drift checks. The three-case receipt below remains the initial probe.

The [fixture-only comparator](../tools/tokscale-compare/README.md) built and ran the
actual pinned Tokscale Rust parser against Centrail over three synthetic cases,
inside filesystem/network namespaces. Repeated executions agreed. Codex and Pi
counted copied usage correctly in both implementations; Tokscale exposed a
filename-derived Codex session label and duplicated the Gemini copy. These findings
are limited to the retained corpus, not the full upstream suite or every source
version. The original pricing formula and Hermes SQL probes remain historical
source/probe evidence; the Rust comparator does not turn them into runtime tests.

Tests cover copied/forked/rotated/partial records, historical growth, malformed
usage, privacy, new-surface capability gates, bounded routes and real PostgreSQL
receipt/account isolation. Final run counts and receipts live with the workstream's
Tokscale implementation evidence. Pi/Gemini incremental conflict checking reads
all files in the configured store, but delivers only changed identities; a persistent
index could reduce that local reading later. Native Windows/macOS execution and production
rollout are not claimed.
