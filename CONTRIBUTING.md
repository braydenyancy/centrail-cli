# Contributing

Thanks for helping improve the Centrail CLI.

## Dev setup

Use Node.js 24.22.1 from `.node-version`, or supported Node.js 22.23.4+.
CI checks these exact security-patched versions on all three operating systems.

```bash
npm ci               # installs the locked workspace dependencies
npm run build        # parsers (tsc) + cli (esbuild bundle)
npm test             # vitest across packages
npm run typecheck
```

- `packages/cli` — the `centrail` bin; [command guide](README.md#install--use).
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

Keep changes focused, include tests, and run `npm run verify`. See [verification](docs/verification.md) for optional
comparison and runtime probes.
