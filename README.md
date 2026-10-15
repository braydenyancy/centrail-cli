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
npx centrail connect          # pair this machine (opens your browser); shows what it found, asks what
                              # to sync, then runs `centrail setup` for the agents installed here
npx centrail setup            # sync after every agent turn: Claude Code's plugin, a hook or extension in the others
npx centrail doctor           # is every agent wired up, and is centrail current? (read-only; --fix repairs)
npx centrail status           # which account this machine syncs to, whether its pairing still works, and updates
npx centrail sync             # push new usage (and git commit attribution)
npx centrail upgrade          # update this copy the way it was installed
npx centrail uninstall        # remove centrail's plugin, hooks and launcher
npx centrail import ccusage.json  # a `ccusage claude daily --json` file as Measured history
npx centrail repos            # every repo and folder seen here, with sync status
npx centrail exclude <repo>   # nothing about this repo leaves (host/owner/repo or folder name)
npx centrail include <repo>   # undo; in allow mode, add it
npx centrail surfaces codex off   # switch a source off (claude-code, codex, copilot-cli, gemini-cli, pi)
npx centrail scope            # ask the scope question again
npx centrail inspect --last   # the last payload, exactly as it left this machine
```

Node.js 20+ required. Each integration runs one per-turn hook that records
session id, folder, repo identity, branch, head and the repos the turn's files
touched, locally, at the end of every turn, and starts a background sync at
most every 10 minutes.

### Agent setup

`centrail setup` detects Claude Code, Codex, Gemini CLI, Copilot CLI and Pi,
prints one line per agent (install, update, repair, ok or skip), asks once, and
applies; a second run changes nothing. `--agent <name>` (claude-code, codex,
gemini-cli, copilot-cli, pi) limits it, `--dry-run` only prints
the plan, `-y` skips the question. Design, launcher and migration details:
[agent integrations](docs/integrations.md).

- **Claude Code** gets its plugin, from the `release` branch of this repo's
  marketplace, with Claude Code's auto-update turned on (`"autoUpdate": true` on
  `extraKnownMarketplaces.centrail` in `~/.claude/settings.json`; opt out under
  `/plugin` → Marketplaces → centrail). Claude Code loads each published version
  on its next launch. Without a `claude` command, setup writes a Stop hook
  through the launcher instead. By hand:
  `claude plugin marketplace add braydenyancy/centrail-cli#release` then
  `claude plugin install centrail@centrail`.
- **Codex** gets one Stop hook in `$CODEX_HOME/hooks.json` that runs the stable
  launcher `~/.config/centrail/bin/centrail-hook` (`.cmd` on Windows). Review and
  trust it once in Codex's `/hooks`: its command never changes between releases,
  so updates need no new trust.
- **Gemini CLI** gets one `AfterAgent` hook named `centrail` in
  `~/.gemini/settings.json`, **Copilot CLI** one `agentStop` hook in its own file
  `~/.copilot/hooks/centrail.json`, and **Pi** one extension,
  `~/.pi/agent/extensions/centrail.js`. All three run the same launcher with
  fixed arguments, and each agent's home variable (`GEMINI_CLI_HOME`,
  `COPILOT_HOME`, `PI_CODING_AGENT_DIR`) is honored.

The launcher runs the centrail that set it up when that install is stable (mise
or a global npm install), else `centrail` on PATH, else `npx centrail`; it never
points into npx's cache. Unrelated hooks are preserved, and `centrail doctor`
reports what each agent runs without printing paths or commands.

`setup-plugin`, `install-hooks`, `uninstall-hooks` and `doctor-hooks` still work
for one release and point at their replacements. After upgrading from them, run
`centrail setup` once to move a pinned Codex hook to the launcher.

### Staying current

The CLI never installs itself unasked. When a newer release is out, a sync in a
terminal says so in one line with the command for how you installed it
(`npx centrail@latest`, `npm i -g centrail@latest`, `mise upgrade
npm:centrail`, or `/plugin marketplace update centrail` in Claude Code for the
plugin); `centrail upgrade` runs that command for you after asking. A sync the
hook started keeps the notice for `centrail status` and `centrail doctor`, which
name the copy it is about and drop a plugin notice once Claude Code has updated
the plugin. `centrail --version` prints the version of the copy you ran. A
version the server no longer accepts stops syncing (the pairing is kept) and
says which version it needs; its hook starts no syncs until the copy is updated.

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
first `centrail sync` in a terminal asks it, or run `centrail scope`; a sync
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
- **Gemini CLI** — `~/.gemini/tmp` and `~/.cache/.gemini/tmp` (under
  `$GEMINI_CLI_HOME` when set).
- **Pi** — `~/.pi/agent/sessions` (`$PI_CODING_AGENT_DIR/sessions`).
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

Package publication is separate from usage sync. Reviewed release PRs coordinate versions and
the plugin bundle; tag CI publishes and verifies the exact tarballs. See [releases](docs/releases.md)
for the workflow and the one-time owner settings. Version 0.8.0 was tagged but never published;
its changes ship in 0.8.1.

- **centrail** — the CLI (this package's `bin`).
- **@centrail/parsers** — the local log parsers and attribution logic. See
  [CONTRACT.md](./CONTRACT.md).

## License

Apache-2.0.
