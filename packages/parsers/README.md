# @centrail/parsers

Node.js readers for local Claude Code, Codex, GitHub Copilot CLI, Gemini CLI and
Pi usage logs, with Git attribution helpers and shared Centrail payload types.
This is a library for local collection and server integration; use the
[`centrail` CLI](https://www.npmjs.com/package/centrail) to pair a machine and sync.

```sh
npm install @centrail/parsers
```

The ESM package exports typed scanners and attribution functions from its
[entrypoint](https://github.com/braydenyancy/centrail-cli/blob/main/packages/parsers/src/index.ts).
It uses Node filesystem APIs and is not a browser package. Scanner results can
contain local paths and context: they are **not upload-ready payloads**. The CLI
applies a separate network allowlist before sending metadata.

Usage readers cover all five sources; the CLI enables commit attribution only
for Claude Code and Codex. Pi and Gemini preserve source session identity and
quarantine conflicting copies or unsupported usage; they do not infer missing
token counters. Uploading them requires explicit server capability and scope
consent.

See the [wire contract](https://github.com/braydenyancy/centrail-cli/blob/main/CONTRACT.md)
and [contributing guide](https://github.com/braydenyancy/centrail-cli/blob/main/CONTRIBUTING.md).
Links to `main` describe the checkout; use your package's matching release tag
for version-specific behavior and its `engines` field for Node requirements.

Apache-2.0. [Source](https://github.com/braydenyancy/centrail-cli).
