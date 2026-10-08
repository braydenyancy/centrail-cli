# Hook integration investigation — local 0.7.4 candidate

## Finding and limits

The launcher/installation design had a reproducible ownership defect: Centrail's
Claude plugin advertised one launcher for both harnesses, while Codex also had
an independently installed user hook. Codex's hook sources are additive. A
Centrail plugin installed in Codex could therefore register a second Stop
execution. A Claude launcher copied into a regular Codex hook source without
plugin context also fails before reaching the shared processor.

**The reported live failure is not yet attributed.** On the inspected Linux
machine there is one explicit Centrail user hook, no enabled/cached Centrail
Codex plugin, and no Centrail plugin trust record. Its pinned Node and bundle
exist. The installed bundle is 0.7.2; Claude's separately enabled plugin is
0.7.3. No live failing Centrail command, stderr, exit status or event-envelope
receipt was available. A sanitized command/error request remains outstanding.
Do not describe the missing-variable fixture as proof of the live incident.

The isolated worktree `centrail-cli-hook-fix` branches from freshly fetched
`origin/main` `bb75b62`, released as `v0.7.3`. Tags were inspected before preparing
unreleased 0.7.4; main CI and the v0.7.3 publish workflow at that exact commit
are successful.
The account-local compatibility branch and the active server
worktree were not edited. No push, tag, publish, PR, merge or deploy occurred;
no installed user hook or plugin cache was changed.

## Configuration and runtime evidence

The inspection selected hook definitions and plugin metadata only. It never
opened installed transcripts, auth files, provider tokens or prompts. All
executed events and transcript fixtures were synthetic and used scratch config.

| Layer or hypothesis | Evidence |
| --- | --- |
| Codex user `hooks.json` | One Centrail Stop handler: quoted absolute Node and bundle, `hook stop`, timeout 10. No plugin-root variable. Both paths exist. |
| Codex user `config.toml` | Hook trust-state tables only, no inline Centrail event. No Centrail plugin enabled; only the dvoid marketplace is configured. |
| Workspace/ancestor layers | No Codex hook/config files found along the workstream's ancestor chain or in its linked repo worktrees. No Centrail workspace hook found. |
| Named user profiles | No `*.config.toml` profile files found. Per-invocation/session overrides and already-loaded session snapshots cannot be established from this disk inspection. |
| System/managed/legacy | `/etc/codex` configuration/requirements/legacy managed files absent; user `managed_config.toml`, `config.json`, and a legacy hooks directory absent. Hook backups are not discovered runtime sources. macOS MDM and Windows managed layers were not accessible on Linux. |
| Codex plugin/cache | No Centrail installation/cache found. A genuine registered Codex plugin receives both `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT`; a regular user hook does not inherit that plugin contract. |
| Claude user settings/registry | `centrail@centrail` enabled; installed plugin version 0.7.3. No standalone Centrail hook in user or local settings. Cache versions 0.7.2/0.7.3 and marketplace hook files contain the shell launcher. These files alone do not prove Codex registration. |
| Missing root variable | Reproduced for a copied regular hook. Ruled out as an inherent property of genuine Codex plugin discovery: actual fixture inventory expands the plugin root into its installed absolute path. |
| Missing `sh` | Not the Linux reproduction: `/bin/sh` launched successfully. Native Windows Codex must not depend on a Unix launcher; its explicit hook now has a native-command regression. |
| Unresolved/stale plugin path | Not established for the live incident. The installed Codex explicit paths exist; Claude cache freshness does not update that separate registration. |
| Duplicate Stop registration | Proven in a real Codex scratch inventory with legacy plugin registration plus explicit user hook; not observed in the inspected local configuration. |
| Payload semantics | Synthetic Claude and Codex Stop envelopes reach the same processor once through their selected launchers. Codex needs a JSON success response; the new explicit command selects it. No live raw event was inspected. |
| Timeout/background execution | No evidence these caused the reported incident. Spawned regression hooks complete within their existing 10-second timeout; the processor's detached, throttled sync behavior is unchanged. |
| Precedence/cleanup | Codex loads matching layers additively. Main's installer also skipped stale Claude entries when the plugin was enabled and deleted an entire group if any handler looked like Centrail. Both cleanup defects reproduced before implementation. |

Official references: [Codex hook locations, trust, plugin environments and Stop
output](https://learn.chatgpt.com/docs/hooks), and [plugin overrides and default
discovery](https://developers.openai.com/plugins/build/plugins). Public Codex
[command runner](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/command_runner.rs)
and [discovery implementation](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs)
were inspected on 2026-10-08. The installed runtime used for the discovery receipt
is Codex 0.161.0. The runtime inspection establishes discovery; trust may still
skip a configured definition until reviewed.

## Minimal reproduction and registry receipt

Before changing code, a scratch working directory, `/usr/bin:/bin` PATH, and an
environment deliberately lacking both plugin-root variables ran:

```sh
sh -c 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh"'
```

Synthetic stdin was a Stop envelope with `session_id: fixture-stop`,
`turn_id: fixture-turn`, `hook_event_name: Stop`, `stop_hook_active: false`, and
`cwd` pointing to that scratch directory. No `transcript_path` was supplied.
Result: empty stdout, `sh: 0: cannot open /scripts/hook.sh: No such file` on
stderr, exit **2**. Failure precedes event parsing and Node discovery.

`plugin.test.ts` retains this negative reproduction, then spawns the generated
explicit Codex command with the root variables omitted. It records exactly one
sidecar row and returns `{}` with exit 0. A second case removes PATH entirely;
Node still starts through its pinned path, while repo identity is unavailable
without Git. Windows uses absolute `cmd.exe`, not the Claude Git Bash runner.

For the actual Codex loader receipt, build and run:

```sh
CENTRAIL_CODEX_BIN=/absolute/path/to/codex node scripts/check-codex-hook-discovery.mjs
```

The script installs only a local fixture marketplace in a disposable empty
HOME/CODEX_HOME. It initializes a scratch app-server and calls `hooks/list`;
it never creates a model turn or loads the user's account. The control models
the released 0.7.3 manifest/default-launcher registration using the current
built processor. It is a registration control, not a byte-identical archived
0.7.3 bundle. Actual discovery returns **2 Stop handlers** (plugin + user).
Manual dispatch of those synthetic registrations on Linux records **2 rows**.
Installing the candidate overlay returns **1 Stop handler**, sourced from the
user file; manual dispatch records **1 row**. This proves loader suppression
and processor execution separately; it does not bypass or test real user trust.

## Final architecture and migration ownership

- `runStopHook` remains the shared processing core and accepts the same event
  schema. Provider detection and detached sync logic are retained.
- Claude's plugin keeps `sh "${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh"`, including
  its sparse-PATH Node discovery. Its launcher is explicitly Claude-owned.
- The Codex compatibility manifest supplies empty inline hooks, replacing
  default discovery. Importing this plugin into Codex does not install collection;
  Codex uses `install-hooks` instead.
- The explicit Codex command pins Node and the CLI bundle, adds `--surface codex`
  for fallback surface/JSON response, and requires no plugin cache, `sh`, shell
  startup file or network resolution. New standalone commands also contain
  `--centrail-hook` as durable ownership evidence at custom installation paths.
  Installing from the plugin's bundled script is refused before any scope/setup
  or hook-settings write, so Codex cannot be pinned to that replaceable cache.
- `setup-plugin` still writes only Claude's user settings through Claude's
  installation flow. It removes identifiable standalone handlers there and
  never modifies Codex settings. A repeated successful setup is idempotent.
- `install-hooks` replaces identifiable legacy/direct-node/absolute plugin
  launchers in its selected user files, consolidates owned duplicates, and
  removes obsolete standalone Claude handlers when the user plugin is enabled.
  It preserves unrelated handlers and group metadata. Uninstall uses the same
  ownership boundary and does not uninstall a harness-managed plugin.
- A bare generic `${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh` has no Centrail identity.
  Automatically deleting it could delete another plugin's hook. It is reported
  for review, never silently claimed. Project, managed, inline TOML registrations
  and stale caches are likewise left to their owning harness. Global exactly-once
  execution cannot be promised while an independent registration remains.
- `doctor-hooks` is a read-only validation of the two user installation files.
  It reports source labels, executable/bundle resolution, Claude user-plugin
  setting, and possible owned duplicates. Ambiguous launchers are separate from
  the owned duplicate count. It prints no commands, paths, usernames, raw config
  values or event content, and executes no hooks. It explicitly says other
  layers, plugin caches and runtime trust are not inspected.

Updating npm or a Claude plugin alone does not rewrite an old explicit Codex
command. After an authorized release, existing Codex users must rerun the new
`install-hooks`, review/trust its changed definition, and reload/restart sessions.
Existing Claude plugin users keep their launcher; users with both an enabled
plugin and a stale standalone user entry get automatic cleanup on reinstall.
Previously imported Codex plugin caches must update through Codex or be removed
there; installing the CLI alone cannot repair those caches. No server migration,
forced historical rescan or wire change is introduced.

## Why the previous tests passed

The plugin test helper unconditionally injected `CLAUDE_PLUGIN_ROOT`, even in
tests described as covering both harnesses. That was correct for Claude but
concealed execution without plugin context. Another test launched the bundle
directly, bypassing the manifest launcher. Tests asserted compatible payload
processing without exercising combined plugin/user registration. Windows plugin
tests used Claude's Git Bash, so they did not exercise native Codex without `sh`.
Installer tests used separate homogeneous groups and an enabled-plugin fixture
with no stale standalone handler, missing both cleanup bugs. Success tests also
accepted silent output without checking Codex's JSON output contract.

Four new cleanup tests first failed against unchanged main: mixed-group loss,
legacy launcher cleanup, deleting unrelated text mentioning Centrail, and
enabled-plugin stale registration. All pass with the fix. Quoting/ownership
round-trip tests also cover arbitrary install paths, renamed runtimes, quoted
punctuation and Windows paths, so conservative cleanup can recognize what the
installer emits.

## Changed files and validation

Implementation: `hooks-install.ts`, `hooks-doctor.ts`, `index.ts`; shared-core
comments in `hook.ts`; new `.codex-plugin/plugin.json`. Tests: `hooks-install.test.ts`,
`hooks-doctor.test.ts`, `plugin-setup.test.ts`, `plugin.test.ts`; optional actual
runtime receipt in `scripts/check-codex-hook-discovery.mjs`. Documentation:
README, plugin README, CONTRACT and this receipt. Release candidate metadata:
CLI/parser package versions, lockfile, marketplace/Claude manifest and CLI
version constant. The generated plugin bundle is rebuilt from the same source.
`hooks/hooks.json` and `scripts/hook.sh` were inspected and intentionally retained.

Linux receipts on **Node 24.21.0**:

| Check | Result |
| --- | --- |
| `npm run build` | Passed, CLI and parser builds. |
| `npm run typecheck` | Passed. |
| `npm test` CLI | **477 passed**, 34 files; **32.12 s** Vitest duration. |
| `npm test` parsers | **166 passed**, 8 files; one existing optional control skipped; **1.25 s**. |
| Claude strict validators | Marketplace and plugin passed. |
| Read-only doctor on installed user files | Passed: enabled Claude plugin, resolving Codex pinned paths, no owned user duplicates; no installed files changed. |
| Codex 0.161.0 loader/dispatch receipt | Passed: 2 legacy registrations/rows → 1 candidate user registration/row. |
| Bundle parity | Existing byte-for-byte bundle test passed; rebuild remains deterministic. |
| CI matrix | Unchanged: Ubuntu/macOS/Windows × Node 20/24. These remote jobs have not run for this unpushed branch. |

Before adding the plugin-cache installation guard, the complete suites also
passed on the checkout's Node 26.8.2 (476 CLI tests and 166 parser tests). The first
complete run caught an unbumped CLI version constant; it was corrected before
the green receipts above. Sandbox subprocess restrictions initially produced
EPERM/empty sidecars; real subprocess verification was rerun with the approved
execution permission. Those sandbox artifacts were not treated as product failures.

## Rollout, rollback and remaining limits

This is a **local candidate**, not protection already delivered to installed users.
No release action is authorized. First obtain the affected incident's sanitized
command, source/hook identifier, platform, error and exit code, plus presence
booleans for launcher variables and a redacted cwd category. Confirm whether the
source is a regular config entry, an actual plugin registration, or another hook.
Do not collect its transcript path, prompts, credentials or raw event content.

When shipping is separately authorized: recheck remote tags and main; reconcile
other unreleased CLI work without overwriting it; run all six existing CI jobs
and manifest validators; follow CONTRACT's contract check and tag-only release
workflow. Rebase/version again if 0.7.4 is released meanwhile. Update both harness
channels, reinstall the explicit Codex user hook, trust the changed definition,
and restart/reload sessions. Canary the effective inventory and one synthetic
Stop on Linux, macOS and native Windows; confirm a single sidecar append without
network/pairing, then verify consented sync separately. Check an imported stale
Codex cache and mixed unrelated hooks before broad rollout.

Rollback is a follow-up patch restoring the previous supported launcher if
needed, plus targeted settings restoration/reinstall; tags must not move. Restoring
an old whole-file backup could overwrite unrelated configuration changed since
installation. Keep the ownership-safe cleanup and restore only the affected
Centrail handler. Disabling/removing the Codex explicit hook leaves manual sync
available. Removing the empty override can reintroduce double registration and
must not be done while the explicit hook remains enabled.

Native macOS/Windows and Node 20 were not run locally. Windows Codex coverage is
in the preserved CI matrix; Claude's shell plugin continues to rely on Claude's
Git Bash environment. A custom Codex hook shell may require its own quoting.
Windows executable paths containing `%` or double quotes, and paths containing
newlines on any OS, are rejected rather than installed ambiguously. Missing Git
limits identity capture; deleted pinned Node/bundle paths require reinstall.
Enabled user-plugin settings are not proof of an already-open session's loaded
state. Managed-only policy, project trust, independent legacy registrations and
already-loaded stale caches remain harness-owned constraints.
