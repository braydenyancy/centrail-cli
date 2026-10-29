# Agent integrations

Use `centrail setup` to install owned integrations and `centrail doctor` to check them.
The [supported-source matrix](../README.md#supported-sources) distinguishes usage collection
from Git attribution. Generated hook definitions and config-path overrides live in
[agent-hooks.ts](../packages/cli/src/commands/agent-hooks.ts); Claude Code setup lives in
[integrations.ts](../packages/cli/src/commands/integrations.ts).

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

**Gemini CLI** gets one `AfterAgent` handler in its user settings. User-level hooks
need no project trust prompt; `/hooks disable centrail` disables it. Settings with
comments are reported as unreadable and never rewritten. See Gemini's
[hook reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md).

**Copilot CLI** gets one `agentStop` entry in `centrail.json` under its hooks directory.
Uninstall removes the file only when no other entries remain. Windows uses the
`powershell` handler; other platforms use `bash`. See Copilot's
[hook reference](https://docs.github.com/en/copilot/reference/hooks-reference).

**Pi** gets `extensions/centrail.js`, loaded at startup. Its `agent_end` handler starts
the launcher detached so Pi never waits for sync. Setup never overwrites a module
without the `centrail-pi-extension` ownership header. See Pi's
[extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).

### Cursor and OpenCode: repo identity only

These opt-in integrations record repository identity but collect no usage. The
dashboard therefore shows no usage for them. `setup` detects and skips them unless
`--agent cursor` or `--agent opencode` is explicit; later setup runs maintain an
installed entry. `doctor` reports uninstalled entries as `not-supported` (not a
failure) and installed ones with `usage: false`. `doctor --fix` does not opt them in.

**Cursor** gets one `stop` hook in `~/.cursor/hooks.json`. The payload uses
`conversation_id` and the first `workspace_roots` entry; its transcript is not read.
On Windows the command uses PowerShell's `&` call operator. Cursor may also run
Claude Code's user hooks, but its payload lacks the Claude fields required for
that hook to record a duplicate. See [Cursor hooks](https://cursor.com/docs/agent/hooks).

**OpenCode v1** (`opencode-ai`) gets `plugins/centrail.js` in its global config dir:
`$XDG_CONFIG_HOME/opencode`, default `~/.config/opencode`, including on Windows.
`OPENCODE_CONFIG_DIR` adds a directory rather than replacing the global one.
The plugin handles `session.status` idle and legacy `session.idle`, deduplicates
the pair, skips child sessions, and uses the SDK session directory (falling back
to the plugin directory). The launcher is detached except on Windows. Setup never
overwrites a module without the `centrail-opencode-plugin` ownership header.
OpenCode v2 (`@opencode/cli`) is unsupported. See [OpenCode plugins](https://opencode.ai/docs/plugins/).

Detection uses each agent's executable on PATH or its config directory; exact
paths and overrides are defined in [agent-hooks.ts](../packages/cli/src/commands/agent-hooks.ts).
Tests redirect homes through [agent-homes.ts](../packages/cli/src/testing/agent-homes.ts)
and [home-overrides.ts](../packages/cli/src/home-overrides.ts).

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
rewritten atomically by each setup and upgrade. Callers keep a fixed path; the
launcher resolves the current install. It finds Node as the plugin's `hook.sh` does
(the discovery block is shared verbatim and tested), then runs the first of:

1. the install that ran setup, when that is a stable location: a mise install through its
   `latest`/major alias, or a global npm prefix (an earlier stable install is kept when setup
   later runs from a non-stable copy);
2. `centrail` on PATH;
3. `npx -y centrail@<major>`.

An npx cache path (`/_npx/`) or the Claude plugin cache is never written into it or into a hook.

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

Deprecated compatibility aliases print a pointer on stderr, then run the commands
below. Update scripts to the replacement commands rather than relying on aliases:

| Old | Now runs |
| --- | --- |
| `setup-plugin` | `setup --agent claude-code` |
| `install-hooks` | `setup -y` (it never asked) |
| `uninstall-hooks` | `uninstall -y`, hooks only, leaving the plugin (its old scope) |
| `doctor-hooks` | `doctor`; with `--json` it still prints the version-1 report |

After upgrading, run `centrail setup` once: it moves pinned Codex entries to the launcher (review
the changed hook in Codex's `/hooks` once) and restart open sessions.

## Uninstall and troubleshooting

`centrail uninstall` removes owned integrations and the launcher when no remaining
selected-out hook needs it. It leaves pairing, scope, sync state and local usage
logs intact; manual `centrail sync` still works. It does not uninstall an npm or
mise package. After removing integrations, remove the global package with
`npm uninstall -g centrail`, or remove the mise tool with `mise uninstall npm:centrail`
and remove its entry from your mise configuration. npx has no global package to remove.
If Claude Code's executable is unavailable, uninstall prints the in-app plugin
removal command; complete that step in Claude Code. Restart open agents afterwards.

- Run `centrail doctor`, then `centrail doctor --fix` to repair owned integration
  entries. Inspect `/hooks` in the agent for trust and disabled-hook state: doctor
  does not prove a hook actually fired.
- Gemini's global hook enable/disable settings are left untouched by setup.
  Enable hooks in Gemini if an installed `AfterAgent` handler does not run.
- Copilot hook setup honors `COPILOT_HOME`; its usage scanner still reads only
  `~/.copilot/session-state`. A healthy hook does not prove logs in a custom home
  will upload.
- “Another sync is running”: wait for the running sync to finish and retry.
  This checkout reports the holder and age when available; older releases may
  show only a generic message. Abandoned locks are reclaimed automatically;
  do not delete a lock while a sync is active. See `packages/cli/src/sync-lock.ts`
  for owner detection and heartbeat expiry.
- OpenCode v2 remains unsupported. Neither Cursor nor OpenCode has a usage
  scanner, even when doctor reports its identity integration as healthy.
- Plugin auto-update depends on the publisher advancing `release`. See the
  [release-channel recovery](releases.md#release-channel-recovery).
