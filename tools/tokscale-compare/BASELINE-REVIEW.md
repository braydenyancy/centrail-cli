# Initial comparison baseline review — 2026-10-09

Accepted as a **regression observation**, not as authority over source usage.
All fifteen Centrail cases match their independently stated source expectations;
all supported competitor executions and Centrail executions repeat identically.
Claude-monitor is explicitly not applicable to non-Claude fixtures. That coverage
matrix is recorded; losing previously executed coverage fails the gate.

The source/pin/observation candidate was independently inspected before adoption.
After the compiler-provenance hardening, its tool pins and every case observation
were compared exactly with the reviewed candidate and were unchanged; only the
adapter protocol fingerprint changed. No source expectation was rewritten to make
a competitor pass. Future updates must repeat this review rather than copy a
candidate automatically.

Reviewed candidate SHA256:
`def12243f1dc4e95bb90381494274ad3dfee71e1e9782d91e35ab3b38ba67248`.
Review report SHA256:
`b01a45f71601cc816c82e8c933baca57f8395f4bb55ec8d7de347eaeb9898a67`.
Retained final executable receipt: [evidence/suite-report.json](evidence/suite-report.json).
Exact observations and protocol/tool pins: [baseline.json](baseline.json).

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
privacy, production prevalence or support for every client version. Full raw
synthetic records and individual source hashes are available in the report so
future reviewers can challenge the conclusions rather than inherit opaque totals.
