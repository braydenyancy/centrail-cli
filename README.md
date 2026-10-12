# centrail

The Centrail CLI syncs your local AI coding-agent usage (Claude Code, GitHub
Copilot CLI, and Codex) to your dashboard at [centrail.org](https://centrail.org) — so you
can see what your AI costs in **dollars, commits, and carbon**.

The local unreleased candidate also supports Pi and Gemini CLI collection during
sync, gated on server capabilities and existing scope consent. See
[implementation scope and verification](docs/tokscale-integration-2026-10.md).
It does not install new Pi/Gemini hooks.

## Install & use

No install needed:

```bash
npx centrail connect          # pair this machine (opens your browser); shows what it found, asks what to sync,
                              # and offers the Claude Code plugin, which then syncs by itself every turn
npx centrail status           # which account this machine syncs to, whether its pairing still works, and updates
npx centrail sync             # push new usage (and git commit attribution)
npx centrail setup-plugin     # the Claude Code plugin question again
npx centrail install-hooks    # sync every turn without the plugin: Codex, or Claude Code
npx centrail import ccusage.json  # a `ccusage claude daily --json` file as Measured history
npx centrail repos            # every repo and folder seen here, with sync status
npx centrail exclude <repo>   # nothing about this repo leaves (host/owner/repo or folder name)
npx centrail include <repo>   # undo; in allow mode, add it
npx centrail surfaces codex off   # switch a source off (claude-code, codex, copilot-cli)
npx centrail setup            # ask the scope question again
npx centrail inspect --last   # the last payload, exactly as it left this machine
```

Node.js 20+ required. Either way of syncing every turn runs one `Stop` hook
that records session id, folder, repo identity, branch, head and the repos the
turn's files touched, locally, at the end of every turn, and starts a
background sync at most every 10 minutes.

### The Claude Code plugin

The primary way for Claude Code: one `Stop` hook over a bundled copy of this
CLI (`plugins/centrail`). `connect` offers to set it up; by hand:

```bash
claude plugin marketplace add braydenyancy/centrail-cli#release
claude plugin install centrail@centrail
```

**Updates.** Claude Code keeps the plugin current, but it auto-updates a
third-party marketplace only when told to: `connect` (or `setup-plugin`) sets
`"autoUpdate": true` on the `centrail` entry of `extraKnownMarketplaces` in
your `~/.claude/settings.json`, or turn it on yourself under `/plugin` →
Marketplaces → centrail → Enable auto-update. The marketplace is pinned to
the `release` branch, which moves to each published version once npm has it;
Claude Code picks the new version up in the background and loads it on its
next launch ("Plugin updated: centrail"). To opt out, disable auto-update in
the same place and update with `/plugin` when you choose. A Stop hook
`install-hooks` wrote earlier in the same user settings is removed when the
plugin is set up. Other configuration layers remain their owner's responsibility.

### Without the plugin

`install-hooks` writes an explicit pinned Node command into Codex's `hooks.json`
(when Codex is installed), and a standalone Claude hook when its user plugin
is disabled. Codex's command needs no plugin-root variable or Unix shell.
The Claude plugin carries an explicit empty Codex hook override, so importing
it into Codex does not register its Claude launcher as a second Stop hook. Install
the CLI once (`npm i -g centrail`) so the hook has a fixed path to run; the
hook pins the `node` that ran the install, so run it again after upgrading
node. After upgrading to the hook-ownership patch, rerun `centrail install-hooks`
to update existing Codex commands, review/trust the changed hook in Codex, and
restart/reload sessions. Updating the package alone does not rewrite settings.

`centrail doctor-hooks` checks the two user installation files without running
hooks or printing commands, paths or config values. It reports pinned executable
and bundle resolution, enabled Claude user-plugin settings, possible duplicates,
and ambiguous plugin-root launchers. It does not inventory project, managed,
inline TOML or cached-plugin hooks; review Codex's hook inventory and Claude's
`/hooks` for the effective runtime sources. Hook sources are additive in Codex.

Reinstall/uninstall preserves unrelated handlers, even when they share a Stop
group with Centrail. Generic `${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh` entries copied
without ownership evidence are reported for review rather than deleted. Uninstall
removes owned standalone entries in these user files; disable/uninstall the Claude
plugin through Claude to stop its plugin hook. See the [local investigation and
rollout receipt](docs/hook-integration-2026-10.md).

### Staying current

The CLI never installs itself. When a newer release is out, a sync in a
terminal says so in one line with the command for how you installed it
(`npx centrail@latest`, `npm i -g centrail@latest`, `mise upgrade
npm:centrail`, or "updates through Claude Code" for the plugin); a sync the
hook started keeps the notice for `centrail status`. A version the server no
longer accepts stops syncing (the pairing is kept) and says which version it
needs; its hook starts no syncs until the copy is updated.

## What leaves your machine

The CLI is **local-first**. It reads your agent's usage logs and computes git
commit attribution **on your machine**. Every field it sends is named in one
allowlist (`packages/cli/src/wire.ts`); nothing else leaves:

- an opaque event ID, model, token counts and timestamp per event; the agent
  and the CLI version per sync
- to a server that accepts them: **repo identity** — the canonical remote
  (`github.com/owner/repo`) or, with no remote, the root-commit hash, plus the
  repo's root commit and the folder name as a label — how the repo was chosen,
  the session id, branch and a random per-install id; fast-mode and
  web-search request counts
- git attribution: repo name or identity, branch, commit SHAs, commit times,
  aggregate line/file counts, whether you authored the commit (your email
  stays local), and the squash commit it landed as; to a server that accepts
  them, a content hash of each commit's change and of its branch so far
  (`git patch-id`), which proves a rebased or squashed commit is the same
  work and reveals none of it
- for a folder that is not a repo: a keyed hash of the path plus the folder name

Never: absolute paths, hostnames, platform details, provider-account details,
source, prompts, completions, diffs, commit messages or secrets. Tool-provided identifiers are used
only as opaque deduplication keys. `centrail inspect --last` prints the real
payload. Two toggles in `~/.config/centrail/config.json`: `hideRepoNames`
(identity ships as a hash, still counted) and `hideBranchNames`, applied to
usage events and git attribution alike. Commit SHAs still go with a hidden
repo (they are what attribution matches), so a public repo's commits can
still be looked up. See [SECURITY.md](./SECURITY.md).

**Which repos.** `connect` lists every repo and folder your agents have touched
on this machine, with the identity each will ship under, and asks once: sync all
(the default, including repos you touch later), or pick. `exclude` means nothing
about that repo leaves: no events, no commits, no identity. `allow` mode syncs
only the repos you list and holds new ones until you `include` them.

**Upgrading from 0.5.x.** Nothing beyond what 0.5.1 sent (usage numbers, and
commit attribution by folder name) leaves until you answer that question. Your
first `centrail sync` in a terminal asks it, or run `centrail setup`; a sync
started by the hook never asks and never waits, and `centrail repos` says
"scope not answered" until you do. Once you answer, your history is re-sent
once with repo identity; the server fills it into the usage it already holds
and never counts anything twice.

**One machine, one account at a time.** Pairing the machine with another
account moves it there: what it already synced stays with the first account,
and the new one gets its own private copy of the local history this machine
can still read. Repeated syncs deduplicate within each account. Older servers
may retain the earlier ownership policy and report events held elsewhere.

Repo identity is the same for every worktree, clone and machine, so one
assignment in the dashboard covers all of them, and a session whose worktree
was deleted before sync still lands on its repo (the hook captured it).

## Where it reads logs

The CLI works on macOS, Linux, and Windows — it resolves every path from your
home directory, so it isn't tied to Unix-style paths.

- **Claude Code** — `~/.claude/projects` by default. It also checks
  `~/.config/claude/projects`, and honors the **`CLAUDE_CONFIG_DIR`** environment
  variable (comma-separated for multi-account setups), matching how Claude Code
  itself and tools like [ccusage](https://ccusage.com) locate the config.
- **GitHub Copilot CLI** — `~/.copilot/session-state`.
- **Codex** — `$CODEX_HOME/sessions` (default `~/.codex/sessions`). The parser
  reads only session/turn metadata and per-call token counts; message,
  reasoning, and tool records are ignored.

The parsers retain limited local context long enough to compute attribution,
but that context is removed by an explicit network allowlist before upload.
They never extract your code, prompts, or completions.

## Tests and implementation comparisons

`npm test` runs the local parser, wire and real-git fixtures. Pairing tests mock
the desktop opener: they do not launch your browser.

After the separate pinned-tool preparation, `npm run test:comparisons` runs
Centrail, Tokscale, ccusage and Claude Code Usage Monitor against shared fixture
trees. Missing tools and unreviewed drift fail explicitly. The suite never reads
your personal logs or downloads tools during testing. See the
[suite instructions](tools/tokscale-compare/README.md) and
[coverage/provenance contract](tools/tokscale-compare/COVERAGE.md).

## Packages

- **centrail** — the CLI (this package's `bin`).
- **@centrail/parsers** — the local log parsers and attribution logic. See
  [CONTRACT.md](./CONTRACT.md).

## License

Apache-2.0.
