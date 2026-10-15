# Security policy

## Reporting a vulnerability

Email **yancy.brayden@gmail.com** with details and reproduction steps. Please do
not open a public issue for security reports. We aim to acknowledge within a few
days.

## What the CLI does and does not do

- It reads local agent usage logs and computes git attribution **locally**.
- It transmits only **allowlisted usage and attribution metadata** (token counts, model names,
  timestamps, repo names, commit metadata) to your configured server.
- It **never** transmits source code, prompts, completions, or secrets.
- The auth token is stored at `~/.config/centrail/auth.json`; a revoked
  pairing is retained in `auth.disconnected.json`. Writes request `0600` on
  POSIX. Windows access follows the user profile's filesystem permissions.
- It refuses to send your token over a non-HTTPS connection; plain `http://` is
  permitted only for `localhost`/loopback (local self-hosting and development).

Repo and branch names, plaintext session IDs and commit SHAs can be identifying.
Review scope with `centrail scope` and the most recent uploaded batch with
`centrail inspect --last`; hiding repo names does not hide commit SHAs. The
[field contract](CONTRACT.md) names the upload allowlist.
