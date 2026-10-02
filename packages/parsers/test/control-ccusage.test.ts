// Control run: ccusage (an independent implementation, Rust, 18k stars) over
// the SAME fixture directory must agree with our scanner on every token
// field. Opt-in — it downloads a native binary through npx — run with
//   CENTRAIL_CONTROL=1 npx vitest run --root packages/parsers control
// ccusage is never a dependency of the product; it is a second opinion.
// Real-corpus comparison: scripts/control-ccusage.mjs.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanClaudeCodeLogs } from "../src/index.js";

const enabled = process.env.CENTRAIL_CONTROL === "1";

// ccusage drops lines without a semver `version` and an ISO timestamp, so the
// fixture carries both, as real transcripts do.
function line(sessionId: string, requestId: string, out: number, atIso: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    requestId,
    timestamp: atIso,
    version: "2.1.0",
    cwd: "/w/repo",
    sessionId,
    message: {
      id: `msg_${requestId}`,
      model: "claude-opus-4-8",
      usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 1000, cache_creation_input_tokens: 25,
        cache_creation: { ephemeral_5m_input_tokens: 25, ephemeral_1h_input_tokens: 0 } },
    },
    ...extra,
  });
}

describe.skipIf(!enabled)("ccusage control run", () => {
  it("agrees with scanClaudeCodeLogs on every token field over a fixture with growth, resume copies and subagents", async () => {
    const config = await mkdtemp(join(tmpdir(), "centrail-control-"));
    const project = join(config, "projects", "-w-repo");
    await mkdir(join(project, "s1", "subagents"), { recursive: true });
    const day = "2026-06-01T12:00:";
    // s1: request A streamed over two lines (5 → 140), request B; resume copy of A in s2.
    await writeFile(join(project, "s1.jsonl"), [line("s1", "req_A", 5, `${day}00.000Z`), line("s1", "req_A", 140, `${day}00.000Z`), line("s1", "req_B", 7, `${day}30.000Z`)].join("\n") + "\n");
    await writeFile(join(project, "s2.jsonl"), [line("s2", "req_A", 140, `${day}00.000Z`), line("s2", "req_C", 9, `${day}59.000Z`)].join("\n") + "\n");
    // subagent transcript under s1 with its own request.
    await writeFile(join(project, "s1", "subagents", "agent-1.jsonl"), line("s1", "req_D", 11, `${day}45.000Z`, { isSidechain: true }) + "\n");

    const ours = await scanClaudeCodeLogs({ basePath: join(config, "projects") });
    const sum = (k: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens") => ours.reduce((a, e) => a + e[k], 0);

    const json = execFileSync("npx", ["-y", "ccusage@latest", "claude", "daily", "--json", "--offline", "--timezone", "UTC"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: config },
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const theirs = (JSON.parse(json) as { totals: Record<string, number> }).totals;

    expect(ours.map((e) => e.externalId).sort()).toEqual(["req_A", "req_B", "req_C", "req_D"]);
    expect(theirs.inputTokens).toBe(sum("inputTokens"));
    expect(theirs.outputTokens).toBe(sum("outputTokens")); // 140 + 7 + 9 + 11, not 5
    expect(theirs.cacheReadTokens).toBe(sum("cacheReadTokens"));
    expect(theirs.cacheCreationTokens).toBe(sum("cacheCreationTokens"));
  });
});
