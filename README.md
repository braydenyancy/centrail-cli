# centrail

The Centrail CLI syncs your local AI coding-agent usage (Claude Code, GitHub
Copilot CLI, and Codex) to your dashboard at [centrail.org](https://centrail.org) — so you
can see what your AI costs in **dollars, commits, and carbon**.

## Install & use

No install needed:

```bash
npx centrail connect          # pair this machine with your account
npx centrail sync             # push new usage (and git commit attribution)
npx centrail install-hooks    # then let Claude Code sync by itself, every turn
npx centrail inspect --last   # the last payload, exactly as it left this machine
npx centrail exclude <repo>   # stop attributing a repo (host/owner/repo or folder name)
```

Node.js 20+ required. For `install-hooks`, install once (`npm i -g centrail`)
so the hook has a fixed path to run; the hook records session id, folder,
repo identity, branch and head locally at the end of every Claude Code turn
and starts a background sync at most every 10 minutes.

## What leaves your machine

The CLI is **local-first**. It reads your agent's usage logs and computes git
commit attribution **on your machine**. Every field it sends is named in one
allowlist (`packages/cli/src/wire.ts`); nothing else leaves:

- an opaque event ID, model, token counts and timestamp per event; the agent
  and the CLI version per sync
- to a server that accepts them: **repo identity** — the canonical remote
  (`github.com/owner/repo`) or, with no remote, the root-commit hash, with the
  folder name as a label — plus the session id, branch and a random
  per-install id
- git attribution: repo name or identity, branch, commit SHAs and aggregate
  line/file counts
- for a folder that is not a repo: a keyed hash of the path plus the folder name

Never: absolute paths, hostnames, platform details, provider-account details,
source, prompts, completions or secrets. Tool-provided identifiers are used
only as opaque deduplication keys. `centrail inspect --last` prints the real
payload. Two toggles in `~/.config/centrail/config.json`: `hideRepoNames`
(identity ships as a hash, still counted) and `hideBranchNames`. See
[SECURITY.md](./SECURITY.md).

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
