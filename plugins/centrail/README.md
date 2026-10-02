# centrail — Claude Code / Codex plugin

One `Stop` hook. Every turn it appends one line to a local sidecar — session id,
folder, repo identity, branch, head, and the repos the turn's files touched —
while the folder still exists, and at most every 10 minutes starts a detached
`centrail sync`. The same `hooks.json` is read by Claude Code and by Codex (its
Stop input is Claude-compatible).

`scripts/centrail.mjs` is the CLI bundle of the same version, copied in at
build time and pinned by the plugin version: nothing is resolved from the
network per turn, and the sync that runs is the one you installed.

```
claude plugin marketplace add braydenyancy/centrail-cli
claude plugin install centrail@centrail
npx centrail connect        # once; pairs this machine and asks which repos sync
```

Nothing leaves the machine except what `npx centrail inspect --last` shows.
`centrail install-hooks` does the same without the plugin, pinned to the node
that ran it.
