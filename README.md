# centrail

The Centrail CLI syncs your local AI coding-agent usage (Claude Code, GitHub
Copilot CLI, and Codex) to your dashboard at [centrail.org](https://centrail.org) — so you
can see what your AI costs in **dollars, commits, and carbon**.

## Install & use

No install needed:

```bash
npx centrail connect          # pair this machine (opens your browser); shows what it found and asks what to sync
npx centrail status           # which account this machine syncs to, and whether its pairing still works
npx centrail sync             # push new usage (and git commit attribution)
npx centrail install-hooks    # then let Claude Code (and Codex) sync by itself, every turn
npx centrail import ccusage.json  # a `ccusage claude daily --json` file as Measured history
npx centrail repos            # every repo and folder seen here, with sync status
npx centrail exclude <repo>   # nothing about this repo leaves (host/owner/repo or folder name)
npx centrail include <repo>   # undo; in allow mode, add it
npx centrail surfaces codex off   # switch a source off (claude-code, codex, copilot-cli)
npx centrail setup            # ask the scope question again
npx centrail inspect --last   # the last payload, exactly as it left this machine
```

Node.js 20+ required. For `install-hooks`, install once (`npm i -g centrail`)
so the hook has a fixed path to run; the hook records session id, folder,
repo identity, branch, head and the repos the turn's files touched, locally,
at the end of every Claude Code or Codex turn, and starts a background sync at
most every 10 minutes.

Or install it as a plugin — one `Stop` hook over a bundled copy of this CLI,
read by Claude Code and by Codex alike (`plugins/centrail`):

```bash
claude plugin marketplace add braydenyancy/centrail-cli
claude plugin install centrail@centrail
npx centrail connect
```

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

## Packages

- **centrail** — the CLI (this package's `bin`).
- **@centrail/parsers** — the local log parsers and attribution logic. See
  [CONTRACT.md](./CONTRACT.md).

## License

Apache-2.0.
