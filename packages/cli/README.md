# centrail

One command turns your AI usage into a dashboard: what your coding agents did, what it cost, and what it produced.

```sh
npx centrail connect
```

That is the whole install. No global package, no SDK, no proxy, no code changes.

## What it does

Centrail is the system of record for AI work. The CLI reads the usage logs your coding agents already write on your machine, attributes tokens to the git commits they helped produce, and syncs usage metadata to your dashboard at [centrail.org](https://centrail.org).

- **Spend**: estimated cost per day, per project, per model. See a year of AI spend in two minutes.
- **Git attribution**: cost per commit, per branch, per PR. What did this PR cost? We're the only ones who can tell you.
- **Budgets and alerts**: get warned when today's burn is a multiple of normal. Your AI bill can never surprise you again.
- **Savings**: see when a cheaper model does the same job. We find you AI savings.
- **Footprint**: estimated energy, water, and CO2 for every token, included free.
- **Teams**: roll the same numbers up per seat and per project. The AI spend report your CFO actually asks for.

## What it tracks

- **Claude Code** (local session logs)
- **GitHub Copilot CLI** (local session logs)
- **Codex** (local session logs)
- Provider APIs and chat-app usage connect on the web side; the CLI is the coding-agent and git half.

## Privacy first

The CLI reads logs locally and sends usage metadata only: token counts, models, timestamps, commit hashes. **Your prompts and your code never leave your machine.** The full guarantee is documented at [Local token capture](https://centrail.org/docs/local-capture) and the [privacy policy](https://centrail.org/docs/privacy).

## Pricing

Personal use is free. Team Standard is $99/mo for 10 seats. Team Pro is $199/mo for 10 seats and adds Trails. Personal Pro is $6/mo. Details at [centrail.org/pricing](https://centrail.org/pricing).

## Links

- Website: [centrail.org](https://centrail.org)
- Docs: [centrail.org/docs](https://centrail.org/docs)
- CLI reference: [centrail.org/docs/cli](https://centrail.org/docs/cli)
- Support: support@centrail.org

## License

Apache-2.0. Source at [github.com/braydenyancy/centrail-cli](https://github.com/braydenyancy/centrail-cli).
