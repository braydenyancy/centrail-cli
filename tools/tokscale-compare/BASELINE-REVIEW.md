# Comparison baseline rationale

The observations in [baseline.json](baseline.json) are regression expectations
for the pinned tools and fixtures, not authority over source usage. Review changes
using the [suite instructions](README.md); do not copy a candidate automatically.
This table explains the accepted differences so future reviews can challenge them.

| Shared fixture | Review of observed differences |
|---|---|
| Claude copies | All token totals agree; Tokscale reports a filename-derived session ID. ccusage daily totals and monitor records cannot validate session identity they do not expose. |
| Claude streaming | Final snapshot output is 140. Monitor retains first output 5; others retain 140. This probes one repeated-ID update shape, not every streaming protocol. |
| Claude spaced JSON | Semantically equivalent JSON remains 140 output in Centrail/Tokscale. ccusage returns zero and monitor retains 5. The raw text/layout-sensitive input is retained exactly. |
| Claude subagents | All token totals agree; independent requests remain present. Aggregated tools do not establish request/session equivalence. |
| Codex copy | Centrail/Tokscale token totals agree; Tokscale's session ID is a filename. ccusage returns zero for this authored layout. This is a format recognition observation, not a blanket Codex-support claim. |
| Codex live/archive | Centrail/Tokscale count shared prefix once plus archived tail: 120 input. ccusage returns 100, omitting this tail in the fixture layout. |
| Codex partial fork | All totals are 750 input; Tokscale has different per-session/per-record attribution. Matching total does not validate the request attribution. |
| Codex sourced task timing | All totals agree: 32 uncached input, 8 cached, 12 output. Tokscale timestamps usage at task/turn starts; Centrail retains token-event timestamps. The public test bytes and added header are separately documented. |
| Copilot resumed shutdown segments | Centrail records two explicitly separated runs: 150 input/20 output. ccusage reports 200/20. Tokscale recognizes no records in this shutdown/workspace fixture format. These are aggregate segments, not fabricated per-request events; this does not mean all Copilot formats fail. |
| Gemini copies | Centrail counts one message; both rivals count two. ccusage's candidate-output excludes thoughts while reported total retains its own convention; do not label that bucket spelling alone a missing-token bug. |
| Gemini tool overlap | Centrail quarantines the unsupported overlap; rivals return positive usage. This is an evidence-policy difference, not proof that their usage is erroneous. |
| Pi cache durations | Source has two distinct response IDs at the same timestamp, with partial/full one-hour subsets. Centrail/Tokscale retain both and 80 total writes. ccusage retains one and 40 writes: identity ambiguity, not evidence of a cache-price arithmetic error. |
| Pi copies | Centrail/Tokscale count the response once; ccusage doubles the copied source. |
| Pi missing counter | Centrail quarantines unobserved input; rivals substitute zero and retain the other counters. This is an uncertainty-policy difference. |
| Pi partial trailing write | All retain the complete prior response and ignore the unfinished tail. |

No comparison establishes invoice accuracy, price correctness, field-level session
privacy, production prevalence or support for every client version. The baseline retains tool observations and source hashes; rerunning the suite
generates a fresh report with raw synthetic records for review.
