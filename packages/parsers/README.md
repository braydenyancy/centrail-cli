# @centrail/parsers

Local AI agent-log parsers (Claude Code, GitHub Copilot CLI, Codex, Pi, and Gemini CLI) plus the
Centrail wire payload types shared between the [`centrail` CLI](https://www.npmjs.com/package/centrail)
and the Centrail server.

See the [repo](https://github.com/braydenyancy/centrail-cli#readme) and
[CONTRACT.md](https://github.com/braydenyancy/centrail-cli/blob/main/CONTRACT.md).
Apache-2.0.

Pi and Gemini readers are local, unreleased additions. Pi reads assistant usage
from session JSONL; Gemini reads JSON/JSONL chat recordings. They preserve source
session identity and quarantine conflicting copies or unsupported usage. They do
not parse prompts into telemetry or infer missing token counters. The CLI requires
explicit server support before syncing these sources. See
[the implementation scope](../../docs/tokscale-integration-2026-10.md).
