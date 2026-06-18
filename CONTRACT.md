# Wire contract

The CLI (client) and the Centrail server communicate over HTTPS. This document
is the source of truth for that contract.

## Endpoints (server: centrail.org)

- `POST /api/cli/pair` and `/api/cli/pair/poll` — device pairing (`connect`).
- `POST /api/cli/ingest` — push usage events (`sync`). Bearer token required.
- `POST /api/cli/attribute` — push git commit attribution (`sync`). Bearer token.

## Payload types

The request/response shapes are the types exported by **@centrail/parsers**
(`ParsedUsageEvent`, `ClaudeCodeAccount`, attribution event/result types). Both
the CLI and the server depend on that package, so the types cannot drift.

## Versioning

Every request carries two headers:

- `centrail-cli-version` — the CLI's package version (informational).
- `centrail-wire` — the **contract version** (currently `1`).

Rules:

- Adding optional fields does **not** bump `centrail-wire`.
- A breaking payload change bumps `centrail-wire`. The server supports the
  **current and previous** contract versions during a deprecation window.
- Requests older than the previous version receive `426 Upgrade Required` with
  guidance to run `npm i -g centrail@latest`.

> Self-hosting: because the client is open and this contract is documented, you
> can point the CLI at your own server with `centrail connect --url <base>`. This
> is possible but not an officially supported product.
