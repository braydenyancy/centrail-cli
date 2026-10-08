import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCANNERS,
  codexHomeDir,
  codexHomeDirs,
  codexSessionsDir,
  scanCodexLogs,
} from "../src/index.js";

function line(type: string, timestamp: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type, payload });
}

const META = line("session_meta", "2026-07-18T12:00:00.000Z", {
  session_id: "sess-codex",
  cwd: "/Users/dev/repo",
  originator: "codex_vscode",
  cli_version: "0.145.0",
  git: { branch: "feature/codex" },
});

const TURN = line("turn_context", "2026-07-18T12:00:01.000Z", {
  turn_id: "turn-1",
  cwd: "/Users/dev/repo",
  model: "gpt-5.6-sol",
});

// Each call ADVANCES the session total, as real Codex does; a token_count
// whose total did not advance is a re-emission, not usage (see the
// re-emission tests below). `callsSoFar` counts from 1.
let calls = 0;
function tokenCount(timestamp = "2026-07-18T12:00:02.000Z"): string {
  const n = ++calls;
  return line("event_msg", timestamp, {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: 1000 * n,
        cached_input_tokens: 700 * n,
        cache_write_input_tokens: 100 * n,
        output_tokens: 80 * n,
        reasoning_output_tokens: 30 * n,
      },
      last_token_usage: {
        input_tokens: 1000,
        cached_input_tokens: 700,
        cache_write_input_tokens: 100,
        output_tokens: 80,
        reasoning_output_tokens: 30,
      },
    },
  });
}

function cumulativeTokenCount(
  timestamp: string,
  input: number,
  cached: number,
  output: number,
): string {
  return line("event_msg", timestamp, {
    type: "token_count",
    info: {
      model: "gpt-5.6-terra",
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
      },
    },
  });
}

async function makeSession(lines: string[], nested = true): Promise<string> {
  calls = 0;
  const base = await mkdtemp(join(tmpdir(), "codex-parser-"));
  const dir = nested ? join(base, "2026", "07", "18") : base;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "rollout.jsonl"), `${lines.join("\n")}\n`);
  return base;
}

describe("scanCodexLogs", () => {
  it("is registered as a first-class CLI scanner", () => {
    expect(SCANNERS.map(({ surface, revision }) => ({ surface, revision }))).toEqual([
      { surface: "claude-code", revision: 3 },
      { surface: "copilot-cli", revision: 2 },
      { surface: "codex", revision: 2 },
    ]);
  });

  it("parses each last_token_usage increment without double-counting cached input", async () => {
    const base = await makeSession([META, TURN, tokenCount()]);
    const [event] = await scanCodexLogs({ basePath: base });

    expect(event.externalId).toBe("sess-codex:turn-1:2026-07-18T12:00:02.000Z");
    expect(event.provider).toBe("openai");
    expect(event.model).toBe("gpt-5.6-sol");
    expect(event.inputTokens).toBe(200);
    expect(event.cacheReadTokens).toBe(700);
    expect(event.cacheCreationTokens).toBe(100);
    expect(event.cacheWriteTokens).toBe(100);
    expect(event.cacheCreation5mTokens).toBe(0);
    expect(event.outputTokens).toBe(80); // reasoning is already a subset
    expect(event.metadata).toMatchObject({
      cwd: "/Users/dev/repo",
      gitBranch: "feature/codex",
      sessionId: "sess-codex",
      version: "0.145.0",
      entrypoint: "codex_vscode",
    });
    expect(event.metadata.origin).toBeUndefined();
  });

  it("emits every incremental token record and uses the active turn model", async () => {
    const secondTurn = line("turn_context", "2026-07-18T13:00:00.000Z", {
      turn_id: "turn-2",
      cwd: "/Users/dev/other-repo",
      model: "gpt-5.6-terra",
    });
    const base = await makeSession([
      META,
      TURN,
      tokenCount(),
      secondTurn,
      tokenCount("2026-07-18T13:00:01.000Z"),
    ]);

    const events = await scanCodexLogs({ basePath: base });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.model)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
    expect(events[1].metadata.cwd).toBe("/Users/dev/other-repo");
    expect(new Set(events.map((e) => e.externalId)).size).toBe(2);
  });

  it("passes through bare and unfamiliar Codex model names", async () => {
    const reviewTurn = line("turn_context", "2026-07-18T12:00:01.000Z", {
      turn_id: "review",
      model: "codex-auto-review",
    });
    const base = await makeSession([META, reviewTurn, tokenCount()]);

    const events = await scanCodexLogs({ basePath: base });

    expect(events.map((event) => event.model)).toEqual(["codex-auto-review"]);
  });

  it("ignores content records, malformed lines, and token counts without usage or model context", async () => {
    const beforeTurn = tokenCount("2026-07-18T11:59:59.000Z");
    const content = line("response_item", "2026-07-18T12:00:01.500Z", {
      type: "message",
      content: [{ type: "output_text", text: "must never become metadata" }],
    });
    const noLast = line("event_msg", "2026-07-18T12:00:03.000Z", {
      type: "token_count",
      info: {},
    });
    const base = await makeSession([META, beforeTurn, "not json", TURN, content, noLast, tokenCount()]);

    const events = await scanCodexLogs({ basePath: base });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain("must never become metadata");
  });

  it("honors since by event time and returns [] for a missing base path", async () => {
    const base = await makeSession([META, TURN, tokenCount()]);
    expect(
      await scanCodexLogs({ basePath: base, since: new Date("2026-07-18T12:00:02.000Z") }),
    ).toEqual([]);
    expect(await scanCodexLogs({ basePath: join(base, "missing") })).toEqual([]);
  });

  it("counts off the rollouts it reads: onFile(done, total) after each, files `since` skips not counted", async () => {
    const base = await makeSession([META, TURN, tokenCount()]);
    await writeFile(join(base, "2026", "07", "18", "second.jsonl"), `${[META, TURN, tokenCount()].join("\n")}\n`);
    const old = new Date("2026-06-01T00:00:00.000Z");
    await utimes(join(base, "2026", "07", "18", "second.jsonl"), old, old);
    const calls: [number, number][] = [];
    const onFile = (done: number, total: number) => void calls.push([done, total]);
    await scanCodexLogs({ basePath: base, onFile });
    expect(calls).toEqual([[1, 2], [2, 2]]);
    calls.length = 0;
    await scanCodexLogs({ basePath: base, since: new Date("2026-06-02T00:00:00.000Z"), onFile });
    expect(calls).toEqual([[1, 1]]);
  });

  it("wholeFiles returns the read file's events before since too, marked context, for the caller to place and not send", async () => {
    const base = await makeSession([META, TURN, tokenCount("2026-07-18T12:00:02.000Z"), tokenCount("2026-07-18T12:00:09.000Z")]);
    const events = await scanCodexLogs({ basePath: base, since: new Date("2026-07-18T12:00:05.000Z"), wholeFiles: true });
    expect(events.map((e) => [e.occurredAt.toISOString(), e.metadata.context ?? false])).toEqual([
      ["2026-07-18T12:00:02.000Z", true],
      ["2026-07-18T12:00:09.000Z", false],
    ]);
  });

  it("does not resurrect already-counted usage when a cumulative-only line follows per-call lines", async () => {
    // Per-call lines without totals leave the cumulative baseline out of sync:
    // the next cumulative-only total overlaps usage that was already emitted,
    // so it must become the new baseline, not an event of its own.
    const lastOnly = line("event_msg", "2026-07-18T12:00:02.000Z", {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 700,
          cache_write_input_tokens: 100,
          output_tokens: 80,
        },
      },
    });
    const base = await makeSession([
      META,
      TURN,
      lastOnly,
      cumulativeTokenCount("2026-07-18T12:01:00.000Z", 1_500, 300, 140),
      cumulativeTokenCount("2026-07-18T12:02:00.000Z", 2_000, 400, 180),
    ]);

    const events = await scanCodexLogs({ basePath: base });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ inputTokens: 200, outputTokens: 80 });
    expect(events[1]).toMatchObject({
      inputTokens: 400,
      cacheReadTokens: 100,
      outputTokens: 40,
    });
  });

  it("suffixes colliding externalIds so same-timestamp calls dedup independently", async () => {
    const base = await makeSession([META, TURN, tokenCount(), tokenCount()]);
    const events = await scanCodexLogs({ basePath: base });
    expect(events).toHaveLength(2);
    expect(events[0].externalId).toBe("sess-codex:turn-1:2026-07-18T12:00:02.000Z");
    expect(events[1].externalId).toBe("sess-codex:turn-1:2026-07-18T12:00:02.000Z:2");
  });

  it("recovers per-call deltas from cumulative totals and event model metadata", async () => {
    const base = await makeSession([
      META,
      cumulativeTokenCount("2026-07-18T12:00:02.000Z", 1_000, 200, 100),
      cumulativeTokenCount("2026-07-18T12:01:02.000Z", 1_500, 300, 140),
    ]);

    const events = await scanCodexLogs({ basePath: base });
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.model)).toEqual([
      "gpt-5.6-terra",
      "gpt-5.6-terra",
    ]);
    expect(events[0]).toMatchObject({
      inputTokens: 800,
      cacheReadTokens: 200,
      outputTokens: 100,
    });
    expect(events[1]).toMatchObject({
      inputTokens: 400,
      cacheReadTokens: 100,
      outputTokens: 40,
    });
  });
});

describe("Codex path resolution", () => {
  const original = process.env.CODEX_HOME;
  afterEach(() => {
    if (original === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original;
  });

  it("defaults to ~/.codex/sessions and honors CODEX_HOME", () => {
    delete process.env.CODEX_HOME;
    expect(codexHomeDir()).toMatch(/\.codex$/);
    expect(codexSessionsDir()).toMatch(/\.codex[\\/]sessions$/);

    process.env.CODEX_HOME = "/custom/codex";
    expect(codexHomeDir()).toBe("/custom/codex");
    expect(codexSessionsDir()).toBe(join("/custom/codex", "sessions"));
  });

  it("supports comma-separated Codex homes", () => {
    process.env.CODEX_HOME = "/work/codex, /personal/codex";
    expect(codexHomeDirs()).toEqual(["/work/codex", "/personal/codex"]);
    expect(codexHomeDir()).toBe("/work/codex");
  });

  it("scans active and archived sessions without duplicate relative paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-homes-"));
    const work = join(root, "work");
    const personal = join(root, "personal");
    const relativeSession = join("2026", "07", "18", "rollout.jsonl");

    for (const path of [
      join(work, "sessions", relativeSession),
      join(work, "archived_sessions", relativeSession),
      join(personal, "archived_sessions", relativeSession),
    ]) {
      await mkdir(dirname(path), { recursive: true });
      const timestamp = path.includes("personal")
        ? "2026-07-18T13:00:02.000Z"
        : "2026-07-18T12:00:02.000Z";
      await writeFile(path, `${[META, TURN, tokenCount(timestamp)].join("\n")}\n`);
    }

    process.env.CODEX_HOME = `${work},${personal}`;
    const events = await scanCodexLogs({});
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.occurredAt.toISOString())).toEqual([
      "2026-07-18T12:00:02.000Z",
      "2026-07-18T13:00:02.000Z",
    ]);
  });
});

describe("Codex turns and touched files", () => {
  it("attaches the turn id and the turn's shell workdir and patch files to its token counts", async () => {
    const base = await mkdtemp(join(tmpdir(), "centrail-codex-ev-"));
    const at = (s: number) => `2026-06-01T12:00:${String(s).padStart(2, "0")}.000Z`;
    const lines = [
      { timestamp: at(0), type: "session_meta", payload: { id: "sess", cwd: "/ws", originator: "codex-tui", cli_version: "0.1" } },
      { timestamp: at(1), type: "turn_context", payload: { turn_id: "t1", model: "gpt-5", cwd: "/ws" } },
      { timestamp: at(2), type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "ls"], workdir: "/ws/a" }) } },
      { timestamp: at(3), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } } } },
      { timestamp: at(4), type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ input: "*** Begin Patch\n*** Update File: a/x.ts\n*** End Patch" }) } },
      { timestamp: at(5), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 2 } } } },
      { timestamp: at(6), type: "turn_context", payload: { turn_id: "t2", model: "gpt-5", cwd: "/ws" } },
      { timestamp: at(7), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 3 } } } },
    ];
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "r.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const events = (await scanCodexLogs({ basePath: base })).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    expect(events.map((e) => e.metadata.turn)).toEqual(["sess#t1", "sess#t1", "sess#t2"]);
    expect(events[0].metadata.touched).toEqual({ writes: [], reads: ["/ws/a"] });
    expect(events[1].metadata.touched).toEqual({ writes: [join("/ws/a", "x.ts")], reads: ["/ws/a"] });
    expect(events[2].metadata.touched).toEqual({ writes: [], reads: [] }); // a new turn starts clean
  });
});

describe("Codex re-emissions and fork replays (ccusage #1288, #1434, #1337)", () => {
  const at = (s: number) => `2026-06-01T12:00:${String(s).padStart(2, "0")}.000Z`;
  const tc = (s: number, total: number, last: number | null) => ({
    timestamp: at(s),
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: total, output_tokens: total / 10 }, ...(last === null ? {} : { last_token_usage: { input_tokens: last, output_tokens: last / 10 } }) } },
  });
  async function scanLines(lines: unknown[], name = "r.jsonl") {
    const base = await mkdtemp(join(tmpdir(), "centrail-codex-re-"));
    await writeFile(join(base, name), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return scanCodexLogs({ basePath: base });
  }
  const head = [
    { timestamp: at(0), type: "session_meta", payload: { id: "sess", cwd: "/ws" } },
    { timestamp: at(0), type: "turn_context", payload: { turn_id: "t1", model: "gpt-5", cwd: "/ws" } },
  ];

  it.each([
    ["with last_token_usage repeated", [tc(1, 100, 100), tc(2, 100, 100), tc(3, 100, 100), tc(4, 300, 200)]],
    ["without last_token_usage", [tc(1, 100, null), tc(2, 100, null), tc(3, 300, null)]],
  ])("a token_count re-emitted with unchanged totals (UI refresh, rate-limit update) is not usage: %s", async (_, counts) => {
    const events = await scanLines([...head, ...counts]);
    const input = events.reduce((n, e) => n + e.inputTokens + e.cacheReadTokens, 0);
    expect(input).toBe(300);
    expect(events).toHaveLength(2);
  });
});

describe("Codex fork replays (ccusage #1337, #1349)", () => {
  const ts = (min: number, s = 0) => `2026-06-01T12:${String(min).padStart(2, "0")}:${String(s).padStart(2, "0")}.000Z`;
  const inc = (at: string, total: number, last: number) => ({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: total, output_tokens: 0 }, last_token_usage: { input_tokens: last, output_tokens: 0 } } } });
  const meta = (id: string, at: string, forkedFrom?: string) => ({ timestamp: at, type: "session_meta", payload: { id, cwd: "/ws", timestamp: at, ...(forkedFrom ? { forked_from_id: forkedFrom } : {}) } });
  const turn = (at: string, id: string) => ({ timestamp: at, type: "turn_context", payload: { turn_id: id, model: "gpt-5", cwd: "/ws" } });
  const parent = [meta("P", ts(0)), turn(ts(0, 1), "p1"), inc(ts(1), 100, 100), inc(ts(2), 300, 200), inc(ts(10), 600, 300)]; // the last one is AFTER the fork
  // The fork at 12:05 replays the parent's first two usage records as a burst with new timestamps, then does its own work.
  const child = [meta("C", ts(5), "P"), turn(ts(5, 1), "c1"), inc(ts(5, 1), 100, 100), inc(ts(5, 1), 300, 200), turn(ts(6), "c2"), inc(ts(7), 350, 50)];
  const write = async (files: Record<string, unknown[]>) => {
    const base = await mkdtemp(join(tmpdir(), "centrail-codex-fork-"));
    for (const [name, lines] of Object.entries(files)) await writeFile(join(base, name), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return base;
  };
  const sumInput = (events: { inputTokens: number; cacheReadTokens: number }[]) => events.reduce((n, e) => n + e.inputTokens + e.cacheReadTokens, 0);

  it("with the parent's rollout present: the child's replayed prefix is not counted; parent 600 + child's own 50", async () => {
    const base = await write({ "rollout-P.jsonl": parent, "rollout-C.jsonl": child });
    expect(sumInput(await scanCodexLogs({ basePath: base }))).toBe(650);
  });

  it("with the parent's rollout gone: the leading burst after a fork marker is treated as replay", async () => {
    const base = await write({ "rollout-C.jsonl": child });
    expect(sumInput(await scanCodexLogs({ basePath: base }))).toBe(50);
  });

  it("an incremental scan that skips the unchanged parent still drops the child's replay", async () => {
    const base = await write({ "rollout-P.jsonl": parent, "rollout-C.jsonl": child });
    const { utimes } = await import("node:fs/promises");
    await utimes(join(base, "rollout-P.jsonl"), new Date("2026-06-01T12:00:30Z"), new Date("2026-06-01T12:00:30Z"));
    const events = await scanCodexLogs({ basePath: base, since: new Date("2026-06-01T12:04:00Z") });
    expect(sumInput(events.filter((e) => e.metadata.sessionId === "C"))).toBe(50);
  });

  it("a session that is not a fork keeps its first burst", async () => {
    const plain = [meta("Q", ts(5)), turn(ts(5, 1), "q1"), inc(ts(5, 1), 100, 100), inc(ts(5, 1), 300, 200)];
    const base = await write({ "rollout-Q.jsonl": plain });
    expect(sumInput(await scanCodexLogs({ basePath: base }))).toBe(300);
  });
});

describe("Codex snapshots out of order (tokscale codex.rs:222)", () => {
  const at = (s: number) => `2026-06-01T12:00:${String(s).padStart(2, "0")}.000Z`;
  const inc = (s: number, total: number, last: number) => ({ timestamp: at(s), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: total, output_tokens: 0 }, last_token_usage: { input_tokens: last, output_tokens: 0 } } } });
  const head = [
    { timestamp: at(0), type: "session_meta", payload: { id: "sess", cwd: "/ws" } },
    { timestamp: at(0), type: "turn_context", payload: { turn_id: "t1", model: "gpt-5", cwd: "/ws" } },
  ];
  const sum = async (lines: unknown[]) => {
    const base = await mkdtemp(join(tmpdir(), "centrail-codex-ooo-"));
    await writeFile(join(base, "r.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return (await scanCodexLogs({ basePath: base })).reduce((n, e) => n + e.inputTokens + e.cacheReadTokens, 0);
  };

  it("a stale snapshot (total steps back by about one increment, then resumes) is not counted", async () => {
    expect(await sum([...head, inc(1, 1000, 1000), inc(2, 1100, 100), inc(3, 1000, 100), inc(4, 1200, 100)])).toBe(1200);
  });

  it("a hard reset (total falls far below, a new baseline) is counted from its last usage", async () => {
    expect(await sum([...head, inc(1, 10000, 10000), inc(2, 50, 50), inc(3, 150, 100)])).toBe(10150);
  });
});

