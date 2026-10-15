// Where a sync's time goes on a large history, against an in-process
// stand-in server: thousands of Claude Code and Codex sessions spread over
// several repositories with many worktrees each, a full sync, then the
// no-change incremental syncs that the Stop hook runs all day. Skipped
// unless CENTRAIL_BENCH is set (it takes minutes and writes ~100 MB to a
// temp dir):
//
//   CENTRAIL_BENCH=1 npx vitest run src/commands/sync.bench.test.ts
//
// Sizes scale with CENTRAIL_BENCH_SCALE (default 1). Each run prints one
// JSON line per sync with its wall time, the phase split from the
// `--verbose` timing line, and the requests the server saw.
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { scratch, type Scratch } from "../testing/git-fixture.js";
import { StandIn, transcriptLine, transcriptPath } from "../testing/stand-in-server.js";

const BENCH = !!process.env.CENTRAIL_BENCH;
const SCALE = Number(process.env.CENTRAIL_BENCH_SCALE ?? "1");
const REPOS = 4;
const WORKTREES = 6; // per repository, beside its main checkout
const BRANCH_COMMITS = 25; // per worktree branch
const CLAUDE_SESSIONS = Math.round(2000 * SCALE);
const CODEX_SESSIONS = Math.round(800 * SCALE);
const REQUESTS = 12; // per session
const RECENT = 0.04; // share of sessions touched in the last day
const PAD = "x".repeat(1500); // a content block's text, near a real transcript line's size

describe.skipIf(!BENCH)("sync bench", () => {
  let home: string;
  let fx: Scratch;
  const server = new StandIn();
  afterAll(async () => {
    server.close();
    await fx?.cleanup();
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("times a full sync and the no-change syncs after it", async () => {
    home = await mkdtemp(join(tmpdir(), "centrail-bench-"));
    vi.stubEnv("CENTRAIL_CONFIG_DIR", join(home, "cfg"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, "claude"));
    vi.stubEnv("CODEX_HOME", join(home, "codex"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "pi"));
    vi.stubEnv("GEMINI_CLI_HOME", join(home, "gemini-home"));
    vi.resetModules();
    const { runSync } = await import("./sync.js");
    const { writeAuth, writeConfig, parseConfig, readState, writeState } = await import("../config.js");
    const { setProgressMode } = await import("../progress.js");

    fx = await scratch();
    const checkouts: string[] = [];
    for (let r = 0; r < REPOS; r++) {
      const main = await fx.repo(`repo${r}`, { remote: `https://github.com/acme/repo${r}.git` });
      checkouts.push(main);
      for (let w = 0; w < WORKTREES; w++) {
        const wt = await fx.worktree(main, `repo${r}-wt${w}`, `feature/${w}`);
        for (let c = 0; c < BRANCH_COMMITS; c++) await fx.commit(wt, `f${c}.txt`, `${c}\n`, new Date(Date.now() - (c + 2) * 3600_000));
        checkouts.push(wt);
      }
    }

    const now = Date.now();
    const old = new Date(now - 30 * 24 * 3600_000);
    // A file's ctime is when this bench wrote it, inside any watermark's 24 h
    // overlap, and scanners read max(mtime, ctime). So the no-change syncs
    // run with every watermark moved two days ahead and the recent files
    // touched after it: exactly those are "changed since the last sync".
    const touched: string[] = [];
    const untouched: string[] = [];
    const ahead = new Date(now + 48 * 3600_000);
    for (let s = 0; s < CLAUDE_SESSIONS; s++) {
      const cwd = checkouts[s % checkouts.length];
      const recent = s < CLAUDE_SESSIONS * RECENT;
      const base = recent ? now - 3600_000 : old.getTime() + s * 1000;
      const lines: string[] = [];
      for (let q = 0; q < REQUESTS; q++) {
        const line = JSON.parse(transcriptLine({ sessionId: `cs${s}`, cwd, requestId: `req_${s}_${q}`, out: 10 + q, atMs: base + q * 1000 }));
        line.message.content = [{ type: "text", text: PAD }];
        lines.push(JSON.stringify(line), JSON.stringify(line)); // two content blocks per response
      }
      const p = transcriptPath(join(home, "claude"), cwd, `cs${s}`);
      await mkdir(join(p, ".."), { recursive: true });
      await writeFile(p, `${lines.join("\n")}\n`);
      (recent ? touched : untouched).push(p);
    }
    for (let s = 0; s < CODEX_SESSIONS; s++) {
      const cwd = checkouts[s % checkouts.length];
      const recent = s < CODEX_SESSIONS * RECENT;
      const at = (q: number) => new Date((recent ? now - 3600_000 : old.getTime() + s * 1000) + q * 1000).toISOString();
      const lines: unknown[] = [{ type: "session_meta", timestamp: at(0), payload: { id: `cx${s}`, cwd, git: { branch: "feature/0" } } }];
      for (let q = 0; q < REQUESTS; q++) {
        const tokens = { input_tokens: 100 + q, cached_input_tokens: 30, output_tokens: 50 + q };
        lines.push(
          { type: "turn_context", timestamp: at(q), payload: { turn_id: `t${s}_${q}`, cwd, model: "gpt-5.6-sol" } },
          { type: "response_item", timestamp: at(q), payload: { type: "message", content: [{ type: "output_text", text: PAD }] } },
          { type: "event_msg", timestamp: at(q), payload: { type: "token_count", info: { total_token_usage: tokens, last_token_usage: tokens } } },
        );
      }
      const p = join(home, "codex", "sessions", "2026", "09", "01", `rollout-${s}.jsonl`);
      await mkdir(join(p, ".."), { recursive: true });
      await writeFile(p, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
      (recent ? touched : untouched).push(p);
    }
    for (const p of untouched) await utimes(p, old, old);

    server.fields = ["repo", "match", "patch-id"];
    await server.start();
    await writeAuth({ baseUrl: server.url, token: "t", deviceName: "bench" });
    await writeConfig(parseConfig({ surfaces: { "copilot-cli": false }, scopeDecidedAt: "2026-06-01T00:00:00Z" }));

    setProgressMode("verbose");
    const stderr: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      stderr.push(String(c));
      return true;
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const results: unknown[] = [];
    for (const [label, full] of [["full", true], ["no-change 1", false], ["no-change 2", false]] as const) {
      stderr.length = 0;
      if (!full) {
        const state = await readState();
        for (const k of Object.keys(state.surfaces)) state.surfaces[k] = ahead.toISOString();
        await writeState(state);
        const later = new Date(ahead.getTime() - 12 * 3600_000);
        for (const p of touched) await utimes(p, later, later);
      }
      const calls = { ingest: server.ingestCalls, attribute: server.attributeBodies.length };
      const t0 = performance.now();
      await runSync({ full });
      const ms = Math.round(performance.now() - t0);
      results.push({
        sync: label,
        ms,
        took: stderr.join("").match(/took: (.*)/)?.[1] ?? null,
        ingestCalls: server.ingestCalls - calls.ingest,
        attributeCalls: server.attributeBodies.length - calls.attribute,
      });
    }
    write.mockRestore();
    log.mockRestore();
    setProgressMode("auto");
    for (const r of results) process.stdout.write(`${JSON.stringify({ claudeSessions: CLAUDE_SESSIONS, codexSessions: CODEX_SESSIONS, checkouts: checkouts.length, ...(r as object) })}\n`);
    expect(server.rows.size).toBeGreaterThanOrEqual(CLAUDE_SESSIONS * REQUESTS);
  }, 30 * 60_000);
});
