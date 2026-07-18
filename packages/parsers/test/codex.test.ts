import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

function tokenCount(timestamp = "2026-07-18T12:00:02.000Z"): string {
  return line("event_msg", timestamp, {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: 1000,
        cached_input_tokens: 700,
        cache_write_input_tokens: 100,
        output_tokens: 80,
        reasoning_output_tokens: 30,
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
  const base = await mkdtemp(join(tmpdir(), "codex-parser-"));
  const dir = nested ? join(base, "2026", "07", "18") : base;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "rollout.jsonl"), `${lines.join("\n")}\n`);
  return base;
}

describe("scanCodexLogs", () => {
  it("is registered as a first-class CLI scanner", () => {
    expect(SCANNERS.map((scanner) => scanner.surface)).toEqual([
      "claude-code",
      "copilot-cli",
      "codex",
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
      origin: { client: "codex_vscode", clientVersion: "0.145.0" },
    });
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
    expect(codexSessionsDir()).toMatch(/\.codex\/sessions$/);

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
