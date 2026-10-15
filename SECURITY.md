# Security policy

## Reporting a vulnerability

Email **yancy.brayden@gmail.com** with details and reproduction steps. Please do
not open a public issue for security reports. We aim to acknowledge within a few
days.

## What the CLI does and does not do

- It reads local agent usage logs and computes git attribution **locally**.
- It transmits only **allowlisted usage and attribution metadata** (token counts, model names,
  timestamps, repo names, commit metadata) to your configured server.
- It does not extract source code, prompts, completions or credential fields for
  upload. Allowed metadata is not a secret scanner: avoid putting sensitive
  information in repo/branch names, model labels or tool-provided identifiers.
- The auth token is stored at `~/.config/centrail/auth.json`; a revoked
  pairing is retained in `auth.disconnected.json`. Writes request `0600` on
  POSIX. Windows access follows the user profile's filesystem permissions.
- It refuses to send your token over a non-HTTPS connection; plain `http://` is
  permitted only for `localhost`/loopback (local self-hosting and development).

Repo and branch names, plaintext session IDs and commit SHAs can be identifying.
Review scope with `centrail scope` and the last attempted usage-ingest batch with
`centrail inspect --last`; this excludes attribution/fate requests and does not
prove server acceptance. Hiding repo names does not hide commit SHAs or patch IDs.
Patch IDs can identify known changes. The repo-name HMAC uses the install id, which
is also uploaded with consented events: it obscures names but is not anonymization
against a recipient testing candidate names. The
[field contract](CONTRACT.md) names the upload allowlist.
