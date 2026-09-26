#!/usr/bin/env node
// Real-corpus control: our scanner vs ccusage over this machine's Claude Code
// logs. Prints one line per token field with the relative difference. Both
// read CLAUDE_CONFIG_DIR (or ~/.claude and ~/.config/claude). Run from the
// repo root after `npm run build`:  node scripts/control-ccusage.mjs
import { execFileSync } from "node:child_process";
import { scanClaudeCodeLogs } from "../packages/parsers/dist/index.js";

const ours = await scanClaudeCodeLogs({});
const sum = (k) => ours.reduce((a, e) => a + e[k], 0);
const json = execFileSync("npx", ["-y", "ccusage@latest", "claude", "daily", "--json", "--offline", "--timezone", "UTC"], {
  encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, timeout: 600_000,
});
const t = JSON.parse(json).totals;
console.log(`requests(ours)=${ours.length}`);
for (const [k, c] of [["inputTokens", t.inputTokens], ["outputTokens", t.outputTokens], ["cacheReadTokens", t.cacheReadTokens], ["cacheCreationTokens", t.cacheCreationTokens]]) {
  const o = sum(k);
  console.log(`${k.padEnd(20)} ours=${String(o).padStart(16)}  ccusage=${String(c).padStart(16)}  diff=${(100 * (c - o) / Math.max(1, o)).toFixed(2)}%`);
}
