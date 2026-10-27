# CLI usage

Use a patched, supported Node.js LTS release on macOS, Linux or native Windows.
The installed package's `engines` field declares its accepted Node versions.
Guidance on `main` describes this checkout; for an installed release, use the
matching [tag](https://github.com/braydenyancy/centrail-cli/tags) and
[release notes](../CHANGELOG.md). `centrail --version` identifies your copy.

## Install and connect

```sh
npx centrail@latest connect
```

Approve pairing in your browser, choose which repositories and folders may sync,
then confirm integration setup. Restart open agent sessions afterwards. For a
persistent command, install with `npm install -g centrail`, then run
`centrail connect`. `mise use -g npm:centrail` is also supported.
These commands work in PowerShell and POSIX shells.

Integration setup records session/repository identity locally after a turn and
starts a background sync at most every ten minutes. It does not replace your
agent or require a Centrail-managed model connection. Preview changes with
`centrail setup --dry-run`; see [integrations](integrations.md) for selection,
trust review, upgrades, and removal.

## Commands

The examples below use an installed `centrail` command; with npx, prefix them
with `npx centrail@latest` instead of `centrail`.

| Command | Purpose |
| --- | --- |
| `centrail status` | Check pairing and the account receiving this machine's usage. |
| `centrail doctor` | Inspect integrations; `--fix` repairs owned entries. |
| `centrail sync` | Upload new usage and supported git attribution; `--full` rescans. |
| `centrail inspect --last` | Print the last attempted usage batch, not proof of delivery or attribution/fate requests. |
| `centrail scope` | Review which repositories and folders may sync. |
| `centrail repos` | List discovered repositories/folders and their sync status. |
| `centrail exclude <repo>` | Exclude a canonical repo identity or folder name. |
| `centrail include <repo>` | Undo exclusion; in allow mode, add it to the selection. |
| `centrail surfaces codex off` | Disable a source (`claude-code`, `codex`, `copilot-cli`, `gemini-cli`, `pi`); use `on` to enable. |
| `centrail import ccusage.json` | Import a `ccusage claude daily/session --json` file as measured history. |
| `centrail upgrade` | Update through the detected installation method, after confirmation. |
| `centrail uninstall` | Remove owned integrations; preserve pairing, scope and local logs. |

`centrail --help` lists commands. [Agent integrations](integrations.md) documents
setup flags and how to remove the npm/mise package after removing integrations.

## Scope and accounts

`connect` lists every repo and folder your agents have touched
on this machine, with the identity each will ship under, and asks once: sync all
(the default, including repos you touch later), or pick. `exclude` means nothing
about that repo leaves: no events, no commits, no identity. `allow` mode syncs
only the repos you list and holds new ones until you `include` them.

**Upgrading from 0.5.x.** Nothing beyond what 0.5.1 sent (usage numbers, and
commit attribution by folder name) leaves until you answer that question. Your
first `centrail sync` in a terminal asks it, or run `centrail scope`; a sync
started by the hook never asks and never waits, and `centrail repos` says
"scope not answered" until you do. Once you answer, your history is re-sent
once with repo identity; the server fills it into the usage it already holds
using the same event identities. Account-local servers deduplicate by account,
provider and external event ID; this does not establish that separately imported
and natively collected records describe different usage.

**One machine, one account at a time.** Pairing the machine with another
account moves it there: what it already synced stays with the first account,
and the new one gets its own private copy of the local history this machine
can still read. Repeated syncs deduplicate within each account. Older servers
may retain the earlier ownership policy and report events held elsewhere.

For a canonical remote, repo identity is the same across worktrees, clones and
machines (hidden names instead use a per-install key), so one
assignment in the dashboard covers all of them, and a session whose worktree
was deleted before sync still lands on its repo (the hook captured it).

## Log locations

`~` means your user home on every platform. Environment-variable names below
identify configuration overrides, not shell-specific assignment commands.

- **Claude Code** — `~/.claude/projects` by default. It also checks
  `~/.config/claude/projects`, and honors the **`CLAUDE_CONFIG_DIR`** environment
  variable (comma-separated for multi-account setups), matching how Claude Code
  itself and tools like [ccusage](https://ccusage.com) locate the config.
- **GitHub Copilot CLI** — `~/.copilot/session-state`. The scanner currently
  ignores `COPILOT_HOME`, even though hook setup honors it.
- **Gemini CLI** — `~/.gemini/tmp` and `~/.cache/.gemini/tmp` (under
  `$GEMINI_CLI_HOME` when set).
- **Pi** — `~/.pi/agent/sessions` (`$PI_CODING_AGENT_DIR/sessions`).
- **Codex** — `$CODEX_HOME/sessions` (default `~/.codex/sessions`). The parser
  reads only session/turn metadata and per-call token counts; message,
  reasoning, and tool records are ignored.

The parsers retain limited local context long enough to compute attribution,
but that context is removed by an explicit network allowlist before upload.
They never extract your code, prompts, or completions.
