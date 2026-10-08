# centrail — Claude Code plugin

One `Stop` hook. Every turn it appends one line to a local sidecar — session id,
folder, repo identity, branch, head, and the repos the turn's files touched —
while the folder still exists, and at most every 10 minutes starts a detached
`centrail sync`. This launcher belongs to Claude Code. Compatible Stop input
does not imply compatible launcher environments or installation ownership.
Codex uses `centrail install-hooks`, which pins Node and the CLI bundle without
plugin-root variables, a Unix shell, shell startup files or network resolution.
`.codex-plugin/plugin.json` explicitly defines no hooks: Codex must not fall back
to this plugin's default `hooks/hooks.json` alongside its explicit user hook.

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
that ran it. Reinstall explicit hooks after upgrading Node or the CLI. Codex
must review/trust changed definitions and reload/restart sessions. Updating an
old plugin cache requires its owning harness's update flow; this source change
does not alter installed caches. `setup-plugin` operates on Claude's user settings
only and removes identifiable standalone Centrail handlers there. It never writes
Codex's hooks file. `doctor-hooks` is a read-only user-file check; the harness's
own hook inventory is authoritative for other layers and trust.
