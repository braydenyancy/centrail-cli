# Centrail CLI

Collect coding-agent usage and associate it with Git work, locally, then sync
selected metadata to [Centrail](https://centrail.org). Track work across agents
and repositories without uploading source code, prompts or completions.

## Quickstart

Use a patched, supported Node.js LTS release on macOS, Linux or Windows:

```sh
npx centrail@latest connect
```

Approve pairing in your browser, choose which repositories may sync, then
confirm agent setup. Restart open agent sessions afterwards. Integrations record
local session/repository identity after each turn and start background syncs at
most every ten minutes.

```sh
npx centrail@latest doctor
npx centrail@latest repos
npx centrail@latest sync
```

See [CLI usage](docs/usage.md) for installation, commands, scope and log locations,
and [agent integrations](docs/integrations.md) for setup, upgrades and removal.
Documentation on `main` describes this checkout; use the matching
[release tag](https://github.com/braydenyancy/centrail-cli/tags) for an installed version.

## Supported sources

| Source | Usage | Git commit attribution |
| --- | --- | --- |
| Claude Code | Yes | Yes |
| Codex | Yes | Yes |
| GitHub Copilot CLI | Yes | No |
| Gemini CLI | Yes, with server capability and scope consent | No |
| Pi | Yes, with server capability and scope consent | No |

Cursor and OpenCode v1 integrations are opt-in and record repository identity
only; they have no usage reader. OpenCode v2 is unsupported.

Attribution associates usage with commits using repository, time, branch and
author evidence. It does not prove AI caused a change or saved time. Token counts
come from local logs; dashboard costs and energy are estimates.

## Privacy

Parsing and attribution run locally. Uploads contain allowlisted metadata,
including usage counts and consented repository/session/branch identifiers,
commit SHAs and aggregate change counts. Names and identifiers can be identifying;
hiding names is not anonymization. Review [the privacy boundary](SECURITY.md)
and [wire contract](CONTRACT.md). `centrail inspect --last` shows only the last
attempted usage batch, not every request or proof of delivery.

## Project and development

- **This repository:** the `centrail` CLI, `@centrail/parsers`, and Claude Code plugin.
- **[centrail](https://github.com/braydenyancy/centrail):** dashboard and server.
- **[centrail-calculations](https://github.com/braydenyancy/centrail-calculations):** versioned calculation methods and artifacts.

Start with [contributing](CONTRIBUTING.md). Run `npm run verify` for the local
build, types, fixtures, contract and package checks. See [verification](docs/verification.md)
for prerequisites and optional [pinned parser comparisons](tools/tokscale-compare/README.md),
and [releases](docs/releases.md) for npm/plugin publication.

[Apache-2.0](LICENSE).
