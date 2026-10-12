# Claude Monitor comparison adapter

Runs the actual `claude_monitor.data.reader.load_usage_entries` from
`Maciek-roboblog/Claude-Code-Usage-Monitor` commit
`c59a83bf943f329f0e61f1a29c760353ee1860a5` (4.0.0). It neither translates nor
mocks the upstream parser. Only shared synthetic Claude JSONL fixtures are
applicable; Codex/Pi/Gemini are not claimed as monitor coverage.

Local suite configuration:

```json
{
  "claude-monitor": {
    "checkout": "/tmp/centrail-claude-monitor-20261009",
    "python": "/usr/bin/python3",
    "pytzWheel": "/tmp/centrail-monitor-wheel/pytz-2024.1-py2.py3-none-any.whl"
  }
}
```

The suite never downloads or installs this dependency. It rejects a wrong commit
or any dirty/untracked checkout files. Source and helper execute only through the
suite's bubblewrap filesystem/network sandbox with explicit fixture root, UTC
reader default, no history cutoff, and all-model filtering. Python runs with
`-I -S -B`: no user site/startup modules, no environment Python path, no bytecode
writes. No user home or live transcripts are mounted.

The reader dependency closure requires `pytz`, not the complete monitor UI/package
installation. Provision its portable pure-Python wheel outside the execution sandbox:

```sh
python3 -m pip download --require-hashes --no-deps --only-binary=:all: \
  -r tools/tokscale-compare/monitor-requirements.txt -d /tmp/centrail-monitor-wheel
```

`pytz` 2024.1 wheel SHA256 is
`328171f4e3623139da4983451950b28e95ac706e13f3f2630a879749e7a8b319`.
The offline adapter verifies exact wheel bytes and unpacks them into a temporary
read-only dependency mount, never installing globally. Baseline identity includes
the wheel, source commit, helper and adapter hashes plus a **CPython 3.12** runtime
contract. The actual interpreter's binary hash and patch version are recorded as
execution provenance rather than machine-specific acceptance criteria. Use a
CPython 3.12 executable under `/usr` (mounted by the suite); other interpreter
families/major-minor versions require review. UTC fixtures do not establish behavior
across local timezone rules. No dependency download occurs in the suite itself.

Upstream's reader constructs its built-in pricing calculator. The helper requests
`CostMode.CALCULATED` and retains its emitted `cost_usd` as an upstream estimate,
not a tariff oracle or actual bill. It preserves every native `UsageEntry` field,
including request/message identity and source-account marker. `UsageEntry` does
not expose a source session ID; the adapter says so rather than inferring it from
path or request identity. No raw transcript payloads are requested.

The executed [probe](evidence/claude-monitor-probe.json) ran each of four fixtures
twice with identical results. Copied completed records and subagent records matched
source token totals. Streaming and spaced streaming JSON retained the first output
snapshot (5 tokens), losing the final 140-token count. These are fixture-level
findings, not evidence of real-user prevalence, upstream full-suite correctness,
pricing accuracy or native cross-platform compatibility. The shared comparison
suite retains its own reviewed baseline and source requirements separately.

[Monitor MIT license](CLAUDE-MONITOR-LICENSE) and
[pytz distribution copyright](PYTZ-COPYRIGHT) are retained. Neither the monitor
application nor its dependencies are added to the production CLI or published
runtime bundle.
