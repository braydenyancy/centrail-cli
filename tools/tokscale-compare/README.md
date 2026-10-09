# Offline parser comparison suite

`npm run test:comparisons` runs the current Centrail source against three pinned
competitors over the **same generated file trees**. It never downloads tools,
scans a real home, fetches prices or uploads results. The competitors are witnesses,
not voting members of a billing oracle.

- Tokscale `d4d1c751856e25913bce97bfbd7b254308863239`: actual Rust
  `UnifiedMessage` parser, uncached, no pricing service.
- ccusage `20.0.24`, exact Linux x64 executable digest: actual native daily report.
- Claude-Code-Usage-Monitor `c59a83bf943f329f0e61f1a29c760353ee1860a5`:
  actual Python reader, pinned pytz wheel, CPython 3.12.

The fifteen shared snapshots cover all five Centrail scanner formats: Claude
streaming updates, copies, subagents and JSON whitespace; Codex copies, partial
forks, live/archive overlap and task timing; Copilot resumed shutdown segments;
Pi copies, missing counters, partial writes and cache-duration subsets; Gemini
copies and unresolved tool-token overlap. Most snapshots are authored synthetic
cases. `codex-sourced-tasks.json` retains a public pinned upstream synthetic fixture
verbatim after an explicitly documented invented header. Every fixture records its
origin, source references and transformations. None is a personal transcript.

## Prepare once, then run offline

Requires Linux bubblewrap namespaces, Node 24, installed workspace dependencies,
Python 3.12 and Rust 1.98.0. Provisioning is explicit and separate from tests; see
[the Linux CI recipe](../../.github/workflows/comparisons.yml) for complete pinned
clone/package/wheel commands. The workflow is added locally; a hosted CI result
has not been claimed. It relaxes the unprivileged-user-namespace restriction only
on that dedicated ephemeral runner so bubblewrap can create its isolated namespaces.

After obtaining the pinned checkouts and ccusage executable:

```sh
RUSTUP_TOOLCHAIN=1.98.0 python3 tools/tokscale-compare/build.py --checkout /tmp/tokscale-comparator --target /tmp/tokscale-comparator-build
python3 -m pip download --require-hashes --no-deps --only-binary=:all: -r tools/tokscale-compare/monitor-requirements.txt -d /tmp/monitor-wheels
```

Create ignored `tools/tokscale-compare/tools.local.json` (or pass `--config`):

```json
{
  "tokscale": {
    "checkout": "/tmp/tokscale-comparator",
    "binary": "/tmp/tokscale-comparator-build/debug/examples/centrail_compare"
  },
  "ccusage": {"binary": "/tmp/ccusage/package/bin/ccusage"},
  "claude-monitor": {
    "checkout": "/tmp/claude-monitor",
    "python": "/usr/bin/python3",
    "pytzWheel": "/tmp/monitor-wheels/pytz-2024.1-py2.py3-none-any.whl"
  }
}
```

```sh
npm run test:comparison-gate
npm run test:comparisons -- --out /tmp/comparison-report
```

The output directory must be new; without `--out` the suite prints its fresh
`/tmp` report path. Missing or wrong tool binaries, missing dependencies, failed
isolation and unavailable execution produce a report and **nonzero exit**. No
unsafe fallback runs against the machine's normal home. Tools must be prepared
beforehand; normal `npm test` does not download competitors. `build.py --offline`
uses cached Cargo dependencies and checks the exact compiler version.

## Source oracle and drift review are separate

`fixtures/*.json` supplies file bytes, independently reasoned expected records and
provenance. `baseline.json` stores reviewed *observations*: tool/source pins,
protocol code hashes, fixture hashes, normalized output, request identity and
explicit coverage. A rival's known disagreement is retained without changing the
source expectation or declaring that rival generally defective.

Every run writes `report.json` and a **candidate**, `baseline-candidate.json`.
The suite never activates the candidate. Before replacing the baseline, inspect
changed source bytes, identities, token conventions and granularity, and record
why each discrepancy is accepted in `BASELINE-REVIEW.md`. Then rerun the gate.
An edited baseline cannot bypass Centrail's source oracle or required execution.
Changes in a tool pin, adapter protocol, fixture, record identity or output fail
until reviewed. Removed fixtures/tools and lost per-client coverage also fail.

Source pins identify portable parser semantics; binary hashes, compiler versions
and Python executable provenance remain in execution evidence. Locally built
Rust executables are checked against their own build receipts instead of
pretending ELF hashes reproduce across build paths/platforms. ccusage's downloaded
native executable is checked against its fixed distribution digest.

The common output projection uses total cache creation, including explicit duration
subsets. Tokscale's visible-output and reasoning buckets are additive; Pi already
keeps reasoning inside output. ccusage Gemini candidate-output versus thoughts
conventions remain explicit in its observation; no missing reasoning is invented.
Monitor's calculated cost is retained as an upstream estimate, never a source
billing oracle. All original synthetic parser records remain in the report.

## Isolation and limits

Both Centrail and rivals execute twice in bubblewrap with separate network/mount
namespaces, cleared environment, read-only source fixtures and no host home mount.
Only executables, parser/dependency code, system libraries, proc/dev and disposable
`/tmp` are visible. Fixture-home environment settings exist only inside the child
when a tool requires them for genuine discovery. The namespace probe verifies
`/home` absent and IP connections return `ENETUNREACH`; source hashes before/after
check nonmutation. Timeouts fail execution. The full fixture objects may contain
synthetic titles/path sentinels for adversarial testing; they are never wire events.

This is a small explicit corpus, not proof of all real-world versions, pricing,
native Windows/macOS behavior or complete upstream suites. Aggregate competitors
cannot validate request identity they do not expose. See `BASELINE-REVIEW.md` for
case-specific conclusions and the retained `evidence/suite-report.json` receipt.

The earlier `run.py` initial probe and `evidence/discrepancies.json` are
historical receipts; `suite.py` is the supported regression command. Upstream
notices are retained alongside each adapter; no native binary is distributed here.
