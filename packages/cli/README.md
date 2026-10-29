# centrail

Sync local coding-agent usage and git attribution to [centrail.org](https://centrail.org).
Use a patched, supported Node.js LTS release on macOS, Linux or Windows.
The package’s `engines` field declares accepted Node versions.

```sh
npx centrail@latest connect
```

Approve pairing in your browser, choose which repos sync, then confirm agent setup.
Claude Code, Codex, GitHub Copilot CLI, Gemini CLI and Pi have usage readers;
git commit attribution covers Claude Code and Codex, the others sync usage only.
Pi and Gemini uploads require server capabilities and scope consent. Cursor and
OpenCode v1 integrations are opt-in and record repo identity only.

```sh
npx centrail doctor          # inspect integrations; --fix repairs
npx centrail sync            # upload usage and git attribution
npx centrail inspect --last  # inspect the last attempted usage batch
npx centrail uninstall      # remove integrations; pairing and local logs remain
```

Usage is parsed locally. The upload allowlist excludes source code, prompts,
completions, absolute paths, diffs and commit messages. Consented uploads can
include repo identity, session and branch identifiers, commit SHAs and aggregate
change counts. See the [privacy boundary](https://github.com/braydenyancy/centrail-cli/blob/main/SECURITY.md).

Use the [CLI guide](https://github.com/braydenyancy/centrail-cli/blob/main/docs/usage.md) for scope,
installation and upgrades, and [agent integrations](https://github.com/braydenyancy/centrail-cli/blob/main/docs/integrations.md)
for setup, removal and troubleshooting. Documentation on `main` may include
unreleased changes; use the matching release tag for your installed version.

Apache-2.0. [Source](https://github.com/braydenyancy/centrail-cli).
