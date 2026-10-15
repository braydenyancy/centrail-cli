# Agent integrations

How centrail runs after every agent turn, and how it stays working across releases.
Source: `packages/cli/src/commands/integrations.ts`, `agent-hooks.ts`, `doctor.ts`, `upgrade.ts`,
`packages/cli/src/launcher.ts`.

## Commands

| Command | Does |
| --- | --- |
| `centrail setup [--agent claude-code\|codex\|gemini-cli\|copilot-cli\|pi\|cursor\|opencode] [-y] [--dry-run]` | Detects installed agents, prints one plan line each (install/update/repair/ok/skip), asks once, applies. Idempotent: a second run writes nothing. Asks the scope question first if it was never answered. Cursor and OpenCode are installed only when named ([below](#cursor-and-opencode-repo-identity-only)). |
| `centrail doctor [--json] [--fix]` | Read-only check of each agent's integration, the launcher and centrail's versions. Exit 1 when something needs action; `--fix` runs `setup -y` for those agents. |
| `centrail uninstall [--agent <name>] [-y]` | Exact inverse of setup, limited to what centrail owns. Asks first (default no). |
| `centrail upgrade [-y]` | Runs the updater of the copy that is running, with consent; then refreshes the launcher. |
| `centrail scope` | Reviews which repos and folders sync (previously `centrail setup`). |

`connect` ends by running `setup` in a terminal; without one it prints the `centrail setup` hint.
Without a terminal, `setup` and `uninstall` change nothing unless `-y` is given.

## Per agent

**Claude Code** gets its plugin (`centrail@centrail` from `braydenyancy/centrail-cli#release`),
installed through `claude plugin …`, with `autoUpdate: true` on the marketplace entry so Claude
Code keeps it current. Any standalone centrail Stop hook in its user settings is removed so turns
are not recorded twice. Only when `claude` is not on PATH, or the plugin install fails, does setup
write an explicit Stop hook running the launcher instead; the next setup with `claude` available
moves to the plugin. An enabled plugin without `claude` on PATH is repaired in settings directly.

**Codex** gets one user Stop hook in `$CODEX_HOME/hooks.json`:

```
"<config dir>/bin/centrail-hook" hook stop --centrail-hook --surface codex
```

`--centrail-hook` marks ownership; `--surface codex` selects Codex's JSON Stop output. Older
centrail entries (pinned Node/bundle paths, `npx` and plugin-launcher forms) are replaced, other
handlers and group metadata are kept. Codex trusts a hook by the hash of its definition, so after
the first install it needs one review in `/hooks`; because the command never changes, later
releases need none. The plugin's `.codex-plugin` manifest declares no hooks, so importing it into
Codex never registers a second Stop hook.

**Gemini CLI** gets one `AfterAgent` handler (once per turn, after the final response) in its user
settings, `~/.gemini/settings.json` (`$GEMINI_CLI_HOME/.gemini/settings.json` when set):

```json
{ "hooks": { "AfterAgent": [ { "hooks": [ { "name": "centrail", "type": "command",
  "command": "\"<config dir>/bin/centrail-hook\" hook stop --centrail-hook --surface gemini-cli",
  "timeout": 10000 } ] } ] } }
```

User-level hooks run without the trust prompt Gemini gives project hooks; `/hooks disable centrail`
turns it off there. `SessionEnd` was not used: it fires once at exit, and Gemini does not wait for
it. A `settings.json` that is not plain JSON (Gemini tolerates comments) is reported as unreadable
and never rewritten. Docs: [hooks](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md),
[reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md).

**Copilot CLI** loads every `*.json` in `~/.copilot/hooks/` (`$COPILOT_HOME/hooks/`); centrail owns
one, `centrail.json`, with one `agentStop` entry (the main agent finished a turn):

```json
{ "version": 1, "hooks": { "agentStop": [ { "type": "command",
  "bash": "\"<config dir>/bin/centrail-hook\" hook stop --centrail-hook --surface copilot-cli",
  "timeoutSec": 10 } ] } }
```

On Windows the field is `powershell` and the command starts with PowerShell's call operator `&`.
Uninstall removes the file when only centrail's entry is in it. `sessionEnd` was not used for the
same reason as Gemini's. Docs: [use hooks](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks),
[reference](https://docs.github.com/en/copilot/reference/hooks-reference).

**Pi** has no hook file; per-turn code is an extension. centrail writes one plain-JavaScript module,
`~/.pi/agent/extensions/centrail.js` (`$PI_CODING_AGENT_DIR/extensions/`), which Pi loads at start
with no package to publish or install. At each `agent_end` it starts the launcher detached with
`hook stop --centrail-hook --surface pi` and `{ session_id, cwd }` on stdin, so Pi never waits on
it. The file is centrail's by its `centrail-pi-extension` header; a `centrail.js` without it is
never touched. Docs: [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md),
[configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md).
Checked against Pi 1.1.0 with a local OpenAI-compatible stub: the extension fired once per run,
and the sidecar's `pi:<id>` matched the Pi scanner's session id for that run.

### Cursor and OpenCode: repo identity only

No log scanner in `packages/parsers` reads Cursor's or OpenCode's usage, so their hook can record
only the per-turn repo identity (session, folder, repo, branch, head) and start a sync; sync has no
usage events to join those lines to, and the dashboard shows nothing for them yet. Installing a hook
that collects nothing visible by default would be a surprise, and leaving them out of the plan would
hide that they were found. So `setup` shows them, detected, as `skip  usage collection not supported
yet (no usage source)`, installs nothing for them, and `--agent cursor` / `--agent opencode` installs
the identity entry on purpose (the sidecar is ready when a scanner lands). Once installed, a plain
`setup` keeps it current like any other; `uninstall` removes it. `doctor` reports a detected agent
with no entry as `not-supported` (not a failure; `--fix` adds nothing) and an installed one as `ok`
with `"usage": false` (printed: "repo identity only; usage not collected yet").

**Cursor** reads user hooks from `~/.cursor/hooks.json` (no variable moves it), shared with the
user's own; centrail adds one entry to `stop`, which fires when the agent loop ends, i.e. once per
turn:

```json
{ "version": 1, "hooks": { "stop": [ { "type": "command",
  "command": "\"<config dir>/bin/centrail-hook\" hook stop --centrail-hook --surface cursor",
  "timeout": 10 } ] } }
```

On Windows Cursor runs hook commands through PowerShell, so the command starts with `&`. `stop`'s
payload has no `cwd`: the session is `conversation_id` (stable across turns) and the folder the first
of `workspace_roots`. `transcript_path` is Cursor's own format and is not read. Cursor parses stdout
as JSON; `{}` asks for no follow-up message. `afterAgentResponse` fires per assistant message, and
`sessionEnd` is tied to the IDE session (window close), so neither marks a turn. Cursor also runs
Claude Code's user hooks (third-party hooks, on by default); a standalone Claude Code centrail hook
there sees Cursor's payload, finds no `session_id` or `cwd`, and records nothing. Docs:
[hooks](https://cursor.com/docs/agent/hooks) (agent-readable: https://cursor.com/docs/hooks.md),
[third-party hooks](https://cursor.com/docs/reference/third-party-hooks.md); Windows shell:
[forum](https://forum.cursor.com/t/hooks-in-windows/150377).

**OpenCode** (v1, the `opencode-ai` package) loads every `plugin/*.{js,ts}` and `plugins/*.{js,ts}`
in its global config dir, `$XDG_CONFIG_HOME/opencode` else `~/.config/opencode` (on Windows too;
`OPENCODE_CONFIG_DIR` adds a directory rather than replacing it). centrail writes one plain-JS
module, `plugins/centrail.js`, whose only export is a plugin function (OpenCode calls every export,
and skips a file with a non-function one). On `session.status` with an idle status (a prompt's run
ended), or the deprecated `session.idle` published with it, it looks the session up through the SDK
client, skips child sessions (`parentID`: a subagent going idle is not a turn), and starts the
launcher with `{ session_id, cwd: session.directory }` on stdin (the plugin's own `directory` when
the lookup fails), detached except on Windows, where OpenCode starts no detached child itself. Owned
by its first-line `centrail-opencode-plugin` header, like Pi's extension. OpenCode v2 (`@opencode/cli`)
loads only `Plugin.define` modules and no longer publishes `session.idle`; it is not covered. Docs:
[plugins](https://opencode.ai/docs/plugins/); source checked at `anomalyco/opencode` v1.19.0
(`packages/opencode/src/config/plugin.ts`, `src/plugin/index.ts`, `src/session/status.ts`) and v2.0.29.
Checked against opencode-ai 1.19.0 with a local OpenAI-compatible stub: per prompt `session.status`
idle then `session.idle` 1 ms later, one launcher run (`--continue` adds one to the same `ses_…`
session), `cwd` the folder `opencode run` started in, and the detached launcher outlived the process.
Not exercised live: a subagent's child session.

Usage sources for later, not built: Cursor keeps none documented locally; OpenCode v1 keeps sessions
and messages (with `tokens` and `cost`) in SQLite at `$XDG_DATA_HOME/opencode/opencode.db`, session
ids `ses_…`, which the identity lines already use as given.

Detection: an agent counts as installed when its command is on PATH (`claude`, `codex`, `gemini`,
`copilot`, `pi`, `cursor`, `opencode`) or its config dir exists (`CLAUDE_CONFIG_DIR` else `~/.claude`;
`CODEX_HOME` else `~/.codex`; `GEMINI_CLI_HOME/.gemini` else `~/.gemini`; `COPILOT_HOME` else
`~/.copilot`; `PI_CODING_AGENT_DIR` else `~/.pi/agent`; `~/.cursor`; `$XDG_CONFIG_HOME/opencode` else
`~/.config/opencode`). Tests never reach these homes: `src/testing/agent-homes.ts` points the
variables, and for Cursor and OpenCode the defaults themselves (`src/home-overrides.ts`), at scratch.

## What `hook stop` receives

One processor for every agent; `--surface` names the agent (none: Claude Code's plugin, told apart
from Codex by its payload) and selects the stdout reply it parses.

| `--surface` | stdin fields read | sidecar session id | stdout |
| --- | --- | --- | --- |
| (none) Claude Code | `session_id`, `cwd`, `transcript_path` | as given | nothing |
| `codex` | `session_id`, `cwd`, `transcript_path` | as given | `{}` |
| `gemini-cli` | `session_id`, `cwd` | `gemini:<id>` | `{}` |
| `copilot-cli` | `sessionId`, `cwd` (or the `Stop` form's `session_id`) | as given | `{}` |
| `pi` | `session_id`, `cwd` | `pi:<id>` | nothing |
| `cursor` | `conversation_id` (or `session_id`), `cwd` else `workspace_roots[0]` | as given | `{}` |
| `opencode` | `session_id`, `cwd` | as given | nothing |

The session id is written the way that agent's log scanner names its sessions, so sync joins the
line to the usage events. Log scanners stay the source of usage; the hook adds the repo identity
while the folder exists, and a timely sync. Cursor and OpenCode have no scanner yet: their lines
wait in the sidecar, joined to nothing. Only Claude Code's and Codex's transcripts are read for
the paths a turn touched; the others are placed by their folder.

## The stable launcher

`<config dir>/bin/centrail-hook` (POSIX `sh`, mode 0755) or `centrail-hook.cmd` on Windows,
rewritten atomically by each setup and upgrade. It is the one file that knows where centrail
lives, the pattern version managers use for shims (mise, asdf, Volta): callers keep a fixed path,
the shim resolves the current install. It finds Node as the plugin's `hook.sh` does (the
discovery block is shared verbatim and tested), then runs the first of:

1. the install that ran setup, when that is a stable location: a mise install through its
   `latest`/major alias, or a global npm prefix (an earlier stable install is kept when setup
   later runs from a non-stable copy);
2. `centrail` on PATH;
3. `npx -y centrail@<major>`.

An npx cache path (`/_npx/`) or the Claude plugin cache is never written into it or into a hook.
Earlier releases pinned the Node and bundle that ran `install-hooks`; run via npx that pinned
npx's cache, which npx may clear.

## Staying current

| Install | Updated by | `centrail upgrade` |
| --- | --- | --- |
| Claude Code plugin | Claude Code (auto-update) | says `/plugin marketplace update centrail` |
| mise | `mise upgrade npm:centrail` | runs it after asking |
| global npm | `npm i -g centrail@latest` | runs it after asking |
| npx | `npx centrail@latest` resolves the newest | nothing to install; refreshes the launcher |

The CLI never installs itself any other way. `status` and `doctor` name the copy each version
notice is about, never repeat one the running copy has outgrown, and drop a plugin notice once
Claude Code's `installed_plugins.json` shows the plugin at or past the version it named.

## Doctor report

`centrail doctor --json` prints one line, `version: 2`:

- `ok` — nothing needs action (an available update is reported, not failed on).
- `cli` — `version`, `copy` (install channel), `latest` known from the last sync, `updateAvailable`.
- `launcher` — `needed`, `present`, `executable`, `resolvesCli` (a stable install, `centrail` or
  `npx` it can run).
- `agents.<claude-code|codex|gemini-cli|copilot-cli|pi|cursor|opencode>` — `detected`, `integration` (`plugin`/`hook`/`none`), `plugin`
  (Claude Code: `enabled`, `autoUpdate`, installed `version`), `hooks` (centrail Stop entries),
  `usesLauncher`, `commandResolves`, `usage` (false: repo identity only), `status` (`ok`, `not-detected`,
  `not-supported` (Cursor/OpenCode found, nothing installed: not a failure), `unreadable`, `missing`,
  `duplicate`, `outdated-pin`, `outdated` (an entry this release would write differently),
  `unresolved` (its launcher is missing), `repair`), `fix` (what setup would do). Pi's and
  OpenCode's `hooks` count their module.
- `notices` — saved version records still true: `copy`, `kind` (`update-available`/`below-minimum`), `line`.

It prints no paths, commands or config values. Codex trust state and project/managed hook layers
are not inspected; each agent's `/hooks` is authoritative for those.

## Migration from the old commands

Kept for one release; each prints a one-line pointer on stderr, then runs:

| Old | Now runs |
| --- | --- |
| `setup-plugin` | `setup --agent claude-code` |
| `install-hooks` | `setup -y` (it never asked) |
| `uninstall-hooks` | `uninstall -y`, hooks only, leaving the plugin (its old scope) |
| `doctor-hooks` | `doctor`; with `--json` it still prints the version-1 report |

After upgrading, run `centrail setup` once: it moves pinned Codex entries to the launcher (review
the changed hook in Codex's `/hooks` once) and restart open sessions.
