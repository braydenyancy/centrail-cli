# centrail — Claude Code / Codex plugin

One `Stop` hook. Every turn it appends one line to a local sidecar — session id,
folder, repo identity, branch, head, and the repos the turn's files touched —
while the folder still exists, and at most every 10 minutes starts a detached
`centrail sync`. The same `hooks.json` is read by Claude Code and by Codex (its
Stop input is Claude-compatible).

`scripts/centrail.mjs` is the CLI bundle of the same version, copied in at
build time and pinned by the plugin version: nothing is resolved from the
network per turn, and the sync that runs is the one you installed.

The hook runs `scripts/hook.sh`, which finds a Node even when Claude Code
was started from the Dock or an IDE whose PATH has none: PATH first, then the
Node that last ran `centrail` in a terminal (recorded in its config dir),
then Homebrew, Volta, mise, asdf, fnm and nvm. With none it prints one line
saying to run `npx centrail setup-plugin` once in a terminal.

```
claude plugin marketplace add braydenyancy/centrail-cli#release
claude plugin install centrail@centrail
npx centrail connect        # once; pairs this machine and asks which repos sync
```

`npx centrail connect` offers to do the first two lines itself, and to turn
on Claude Code's auto-update for this marketplace (off by default for
third-party ones): `"autoUpdate": true` on `extraKnownMarketplaces.centrail`
in `~/.claude/settings.json`, or `/plugin` → Marketplaces → centrail →
Enable auto-update. `#release` is a branch the publish workflow moves to each
published version; Claude Code sees the plugin's bumped `version` and loads
the new one on its next launch.

Nothing leaves the machine except what `npx centrail inspect --last` shows.
`centrail install-hooks` does the same without the plugin, pinned to the node
that ran it.
