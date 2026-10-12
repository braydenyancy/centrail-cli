# ccusage comparator

The adapter executes **ccusage 20.0.24**, the Linux x64 native executable shipped by
`@ccusage/ccusage-linux-x64@20.0.24`. Its required SHA-256 is
`d8979af0f2ca2ee523ee641ea01e2ea99cdf55d7f7c460eeedb623f8c599b397`.
The executable was already present in the local npm cache; no live user logs were
used to establish its results. This is a pinned published binary, not a claim
that this workstream reproduced its release build.

The current [upstream repository](https://github.com/ccusage/ccusage) has Rust
adapters and an npm launcher that selects platform binaries. Earlier ccusage
versions used another implementation; do not identify the executable by the
project name alone.

Set `ccusage.binary` in the suite's local tool configuration to the native
executable. The runner checks its exact bytes before execution and confirms
`ccusage 20.0.24` inside the sandbox. Other releases/platform builds need their
own reviewed pins; changing a binary is not an automatic baseline update.
Preparing a missing tool is a separate explicit action, for example installing
`ccusage@20.0.24` in a temporary prefix and pointing at its native package. Neither
the suite nor the compatibility control entrypoint invokes npm or downloads.

Each invocation uses one named source (`claude`, `codex`, `pi`, `gemini`, or
`copilot`) and `daily --json --offline --timezone UTC`. The suite supplies only
synthetic fixture files through read-only bindings and a network namespace with
no external network. Tool-specific roots and HOME exist only inside that isolated
child environment; they do not change the host agent's environment. An offline
flag alone is not the isolation boundary.

## What is comparable

Daily output exposes aggregates, not provider event identities. The adapter
compares reported input/output/cache-read/cache-creation counts with source
oracles and retains `totalTokens` independently. It does not invent a reasoning
breakdown, request IDs, session lineage or cash spending. In particular, a
tool's `outputTokens` may omit thoughts even when `totalTokens` includes them;
the report preserves that limitation instead of hiding it through arithmetic.

The Claude fixtures are hand-authored, explicitly synthetic cases. Compact
streaming, duplicate copies and separate subagent calls exercise normal source
format behavior. A separate valid JSON-with-spaces case tests parser robustness:
the actual pinned binary produces zero for this case while the compact
equivalent is counted. These are observed outcomes, not an instruction to make
Centrail match ccusage. All fixtures carry their own provenance and expected
source accounting.

`scripts/control-ccusage.mjs` and the optional `CENTRAIL_CONTROL=1` test now invoke
the shared fixture suite. Their former implicit personal-home scan and
`ccusage@latest` download path have been removed.
