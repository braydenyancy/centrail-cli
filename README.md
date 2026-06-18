# centrail

The Centrail CLI syncs your local AI coding-agent usage (Claude Code today) to
your dashboard at [centrail.org](https://centrail.org) — so you can see what your
AI costs in **dollars, commits, and carbon**.

## Install & use

No install needed:

```bash
npx centrail connect          # pair this machine with your account
npx centrail sync             # push new usage (and git commit attribution)
npx centrail exclude <repo>   # stop attributing a repo
```

Node.js 20+ required.

## What leaves your machine

The CLI is **local-first**. It reads your agent's usage logs and computes git
commit attribution **on your machine**, and sends only **derived counts** (tokens
per model, timestamps, repo names, commit metadata). It never sends your source
code, your prompts, your completions, or any secrets. See [SECURITY.md](./SECURITY.md).

## Packages

- **centrail** — the CLI (this package's `bin`).
- **@centrail/parsers** — the local log parsers + the wire payload types shared
  with the Centrail server. See [CONTRACT.md](./CONTRACT.md).

## License

Apache-2.0.
