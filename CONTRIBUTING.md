# Contributing

Thanks for helping improve the Centrail CLI.

## Dev setup

```bash
npm install          # links the workspace packages
npm run build        # parsers (tsc) + cli (esbuild bundle)
npm test             # vitest across packages
npm run typecheck
```

- `packages/cli` — the `centrail` bin (commands: connect, sync, exclude).
- `packages/parsers` — local log parsers + shared wire types.

## Adding a provider parser

New coding-agent parsers live in `packages/parsers/src/providers/<agent>.ts`
(e.g. `claude-code.ts`). Export them from `packages/parsers/src/index.ts`, add
tests beside them, and keep the parser **counts-only** — never read or transmit
source or prompts.

## Wire changes

If you change a request/response shape, update [CONTRACT.md](./CONTRACT.md) and
follow the versioning rules there. Breaking changes bump `centrail-wire`.

## PRs

Keep changes focused, include tests, and ensure `npm run build && npm test &&
npm run typecheck` are green.
