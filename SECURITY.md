# Security policy

## Reporting a vulnerability

Email **yancy.brayden@gmail.com** with details and reproduction steps. Please do
not open a public issue for security reports. We aim to acknowledge within a few
days.

## What the CLI does and does not do

- It reads local agent usage logs and computes git attribution **locally**.
- It transmits only **derived, non-sensitive data** (token counts, model names,
  timestamps, repo names, commit metadata) to your configured server.
- It **never** transmits source code, prompts, completions, or secrets.
- The auth token is stored at `~/.config/centrail/auth.json` with `0600`
  permissions.
- It refuses to send your token over a non-HTTPS connection; plain `http://` is
  permitted only for `localhost`/loopback (local self-hosting and development).

Future provider-API-key support will store keys in the OS keychain and perform
all key-bearing work locally; keys will never be transmitted.
