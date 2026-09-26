// Adversarial: try to make one API response count twice, or two count once.
// The corpus fact these lean on (79,014 requests, `ts_probe.py` in the
// workstream receipts): 99.3% of multi-line requests have a DIFFERENT
// `timestamp` on every line, because each content block is written as it
// arrives. Any key that includes the timestamp therefore splits a response.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanClaudeCodeLogs } from "../src/index.js";

type Usage = Partial<{ in: number; out: number; cr: number; cc: number; c5: number; c1: number }>;
type LineOpts = { requestId?: string | null; msgId?: string; sessionId?: string; at: string; usage: Usage };

function line(o: LineOpts): string {
  const u = o.usage;
  const raw: Record<string, unknown> = {
    type: "assistant",
    timestamp: o.at,
    cwd: "/Users/dev/repo",
    sessionId: o.sessionId ?? "sess-1",
    message: {
      id: o.msgId ?? "msg_01",
      model: "claude-opus-4-8",
      usage: {
        input_tokens: u.in ?? 0,
        output_tokens: u.out ?? 0,
        cache_read_input_tokens: u.cr ?? 0,
        cache_creation_input_tokens: u.cc ?? 0,
        cache_creation: { ephemeral_5m_input_tokens: u.c5 ?? 0, ephemeral_1h_input_tokens: u.c1 ?? 0 },
      },
    },
  };
  if (o.requestId !== null) raw.requestId = o.requestId ?? "req_01";
  return JSON.stringify(raw);
}

async function scan(lines: string[], since?: Date) {
  const base = await mkdtemp(join(tmpdir(), "centrail-dedup-"));
  await mkdir(join(base, "p"), { recursive: true });
  await writeFile(join(base, "p", "s.jsonl"), `${lines.join("\n")}\n`);
  return scanClaudeCodeLogs({ basePath: base, since });
}

const T = (s: number) => `2026-06-01T12:00:${String(s).padStart(2, "0")}.000Z`;

// One response, three content blocks, output growing, timestamps apart —
// the shape 57,373 real requests have. Both id shapes must collapse it.
const streamed = (idShape: { requestId?: string | null }) => [
  line({ ...idShape, at: T(5), usage: { in: 10, out: 4, cr: 1000, cc: 300, c5: 100, c1: 200 } }),
  line({ ...idShape, at: T(7), usage: { in: 10, out: 90, cr: 1000, cc: 300, c5: 100, c1: 200 } }),
  line({ ...idShape, at: T(8), usage: { in: 10, out: 140, cr: 1000, cc: 300, c5: 100, c1: 200 } }),
];

describe("one response is one event", () => {
  it.each([
    ["with requestId", { requestId: "req_01" }],
    ["without requestId (Bedrock / Vertex / gateway)", { requestId: null }],
  ])("%s: three lines seconds apart collapse to one event at the final count", async (_, idShape) => {
    const events = await scan(streamed(idShape));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ inputTokens: 10, outputTokens: 140, cacheReadTokens: 1000, cacheCreationTokens: 300, cacheCreation5mTokens: 100, cacheCreation1hTokens: 200 });
    expect(events[0].occurredAt.toISOString()).toBe(T(5)); // the request started at its first line
  });

  it.each([
    [[0, 1, 2]],
    [[2, 1, 0]],
    [[1, 2, 0]],
    [[2, 0, 1]],
  ])("is order-independent: permutation %j gives the same event", async (order) => {
    const src = streamed({ requestId: null });
    const events = await scan(order.map((i) => src[i]));
    expect(events).toHaveLength(1);
    expect(events[0].outputTokens).toBe(140);
    expect(events[0].occurredAt.toISOString()).toBe(T(5));
  });

  it("interleaved responses keep their own maxima", async () => {
    const events = await scan([
      line({ requestId: "req_A", msgId: "msg_A", at: T(1), usage: { out: 5 } }),
      line({ requestId: "req_B", msgId: "msg_B", at: T(2), usage: { out: 50 } }),
      line({ requestId: "req_A", msgId: "msg_A", at: T(3), usage: { out: 30 } }),
      line({ requestId: "req_B", msgId: "msg_B", at: T(4), usage: { out: 60 } }),
    ]);
    expect(Object.fromEntries(events.map((e) => [e.externalId, e.outputTokens]))).toEqual({ req_A: 30, req_B: 60 });
  });

  it("a response whose lines straddle `since` still lands once, at its final count", async () => {
    // Incremental sync: the watermark falls between the first and last line
    // of a long streaming turn. The event must not be dropped and must not
    // be counted at the streamed-so-far value.
    const events = await scan(streamed({ requestId: "req_01" }), new Date(T(6)));
    expect(events).toHaveLength(1);
    expect(events[0].outputTokens).toBe(140);
  });
});

describe("two responses are two events", () => {
  it.each([
    ["different requestIds, same message id", [{ requestId: "req_1", msgId: "msg_X" }, { requestId: "req_2", msgId: "msg_X" }]],
    ["no requestId, different message ids", [{ requestId: null, msgId: "msg_1" }, { requestId: null, msgId: "msg_2" }]],
    ["no requestId, same message id, different sessions", [{ requestId: null, msgId: "msg_1", sessionId: "s1" }, { requestId: null, msgId: "msg_1", sessionId: "s2" }]],
  ])("%s", async (_, [a, b]) => {
    const events = await scan([line({ ...a, at: T(1), usage: { out: 7 } }), line({ ...b, at: T(2), usage: { out: 9 } })]);
    expect(events.map((e) => e.outputTokens).sort((x, y) => x - y)).toEqual([7, 9]);
    expect(new Set(events.map((e) => e.externalId)).size).toBe(2);
  });

  it("the fallback id is stable across rescans (the server's unique index needs it)", async () => {
    const src = streamed({ requestId: null });
    const [first] = await scan(src);
    const [second] = await scan(src);
    expect(second.externalId).toBe(first.externalId);
    expect(first.externalId).toMatch(/^msg:/);
    expect(first.externalId).not.toContain("2026-06-01T"); // no timestamp in the key
  });
});

describe("model fallback: one response, two iterations on two models", () => {
  // The real shape (req_011Ce2K7ywCcaxK5vttuZGeT on the reference corpus):
  // streamed lines carry the FIRST attempt's input and cache counts (the
  // model label flips early); the final line's top-level counts are the
  // fallback's, but its top-level cache split is still the first attempt's;
  // only the fallback_message iteration's own split is right. Checked
  // against ccusage, codeburn, tokscale, splitrail, claude-monitor and
  // phuryn/claude-usage: none counts the first attempt.
  const u = (out: number, cr: number, cc: number, split5m: number, iterations?: unknown[]) => ({
    input_tokens: 2, output_tokens: out, cache_read_input_tokens: cr, cache_creation_input_tokens: cc,
    cache_creation: { ephemeral_5m_input_tokens: split5m, ephemeral_1h_input_tokens: 0 },
    ...(iterations ? { iterations } : {}),
  });
  const ln = (at: string, model: string, usage: unknown) =>
    JSON.stringify({ type: "assistant", requestId: "req_fb", timestamp: at, cwd: "/r", sessionId: "s", message: { id: "msg_fb", model, usage } });
  const streamed = [
    ln(T(1), "claude-fable-5", u(2, 64529, 747, 747)),
    ln(T(2), "claude-opus-4-8", u(2, 64529, 747, 747)),
    ln(T(3), "claude-opus-4-8", u(2, 64529, 747, 747)),
  ];
  const final = ln(T(4), "claude-opus-4-8", u(648, 63242, 0, 747, [
    { type: "message", model: "claude-fable-5", input_tokens: 2, output_tokens: 142, cache_read_input_tokens: 64529, cache_creation_input_tokens: 747, cache_creation: { ephemeral_5m_input_tokens: 747, ephemeral_1h_input_tokens: 0 } },
    { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 2, output_tokens: 648, cache_read_input_tokens: 63242, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
  ]));
  const shape = (events: Awaited<ReturnType<typeof scanClaudeCodeLogs>>) =>
    events
      .sort((a, b) => a.externalId.localeCompare(b.externalId))
      .map((e) => [e.externalId, e.model, e.outputTokens, e.cacheReadTokens, e.cacheCreationTokens, e.cacheCreation5mTokens]);
  const expected = [
    ["req_fb", "claude-opus-4-8", 648, 63242, 0, 0],
    ["req_fb:iter:0", "claude-fable-5", 142, 64529, 747, 747],
  ];

  it.each([
    ["in file order", [...streamed, final]],
    ["final line first", [final, ...streamed]],
    ["final line in the middle", [streamed[0], final, streamed[1], streamed[2]]],
  ])("the response is the fallback, the first attempt is its own event, nothing counted twice (%s)", async (_, lines) => {
    const base = await mkdtemp(join(tmpdir(), "centrail-fb-"));
    await mkdir(join(base, "p"), { recursive: true });
    await writeFile(join(base, "p", "s.jsonl"), `${lines.join("\n")}\n`);
    expect(shape(await scanClaudeCodeLogs({ basePath: base }))).toEqual(expected);
  });

  it("a transcript cut before the fallback line is one ordinary request on the first attempt", async () => {
    const base = await mkdtemp(join(tmpdir(), "centrail-fb-"));
    await mkdir(join(base, "p"), { recursive: true });
    await writeFile(join(base, "p", "s.jsonl"), `${streamed.join("\n")}\n`);
    expect(shape(await scanClaudeCodeLogs({ basePath: base })).map((r) => r[0])).toEqual(["req_fb"]);
  });

  it.each([
    ["one iteration (the common case)", [{ type: "message", model: null, input_tokens: 1, output_tokens: 2 }], []],
    ["executor iterations that carry a model, no fallback: they ARE the top-level usage", [{ type: "message", model: "m", input_tokens: 1, output_tokens: 1 }, { type: "message", model: "m", input_tokens: 0, output_tokens: 1 }], []],
    ["no iterations", undefined, []],
    ["an iteration list that is not an array", "x", []],
    ["an advisor call last (ccusage advisor_message)", [{ type: "message", model: null, input_tokens: 1, output_tokens: 2 }, { type: "advisor_message", model: "adv", input_tokens: 5, output_tokens: 6 }], ["r1:advisor:1"]],
    ["an advisor call in the middle", [{ type: "message", model: null, input_tokens: 1, output_tokens: 1 }, { type: "advisor_message", model: "adv", input_tokens: 5, output_tokens: 6 }, { type: "message", model: null, input_tokens: 0, output_tokens: 1 }], ["r1:advisor:1"]],
  ])("%s", async (_, iterations, extra) => {
    const base = await mkdtemp(join(tmpdir(), "centrail-fb-"));
    await mkdir(join(base, "p"), { recursive: true });
    const raw = { type: "assistant", requestId: "r1", timestamp: T(1), sessionId: "s", message: { id: "m1", model: "m", usage: { input_tokens: 1, output_tokens: 2, ...(iterations === undefined ? {} : { iterations }) } } };
    await writeFile(join(base, "p", "s.jsonl"), `${JSON.stringify(raw)}\n`);
    expect((await scanClaudeCodeLogs({ basePath: base })).map((e) => e.externalId).sort()).toEqual(["r1", ...extra].sort());
  });
});

describe("found by the cross-tool comparison", () => {
  const write = async (files: Record<string, string[]>) => {
    const base = await mkdtemp(join(tmpdir(), "centrail-xt-"));
    for (const [rel, lines] of Object.entries(files)) {
      const p = join(base, rel);
      await mkdir(join(p, ".."), { recursive: true });
      await writeFile(p, `${lines.join("\n")}\n`);
    }
    return base;
  };
  const a = (o: { rid: string; mid: string; sid?: string; side?: boolean; out: number; at: string }) =>
    JSON.stringify({ type: "assistant", requestId: o.rid, timestamp: o.at, sessionId: o.sid ?? "s", isSidechain: o.side ?? false, message: { id: o.mid, model: "m", usage: { input_tokens: 1, output_tokens: o.out } } });

  it.each([
    ["parent first", false],
    ["replay first", true],
  ])("a /btw sidechain replaying a parent message under a NEW requestId is the same response (ccusage lib.rs:238) — %s", async (_, replayFirst) => {
    const parent = a({ rid: "req_parent", mid: "msg_1", out: 50, at: T(1) });
    const replay = a({ rid: "req_replay", mid: "msg_1", side: true, out: 50, at: T(5) });
    const base = await write({ "p/s.jsonl": replayFirst ? [replay, parent] : [parent, replay] });
    const events = await scanClaudeCodeLogs({ basePath: base });
    expect(events.map((e) => [e.externalId, e.outputTokens])).toEqual([["req_parent", 50]]);
  });

  it.each([
    ["two non-sidechain responses reusing a message id (a gateway) stay two", [a({ rid: "r1", mid: "msg_g", out: 1, at: T(1) }), a({ rid: "r2", mid: "msg_g", out: 2, at: T(2) })], 2],
    ["a sidechain in ANOTHER session with the same message id stays separate", [a({ rid: "r1", mid: "msg_x", out: 1, at: T(1) }), a({ rid: "r2", mid: "msg_x", sid: "other", side: true, out: 2, at: T(2) })], 2],
    ["a subagent's own responses (own message ids) stay", [a({ rid: "r1", mid: "msg_p", out: 1, at: T(1) }), a({ rid: "r2", mid: "msg_sub", side: true, out: 2, at: T(2) })], 2],
  ])("%s", async (_, lines, n) => {
    const base = await write({ "p/s.jsonl": lines });
    expect(await scanClaudeCodeLogs({ basePath: base })).toHaveLength(n);
  });

  it("subagent transcripts nested under <session>/subagents/workflows/<wf>/ are scanned (ccusage paths.rs)", async () => {
    const base = await write({
      "p/s.jsonl": [a({ rid: "r_top", mid: "m1", out: 1, at: T(1) })],
      "p/s/subagents/agent-1.jsonl": [a({ rid: "r_sub", mid: "m2", side: true, out: 1, at: T(2) })],
      "p/s/subagents/workflows/wf_1/agent-a.jsonl": [a({ rid: "r_wf", mid: "m3", side: true, out: 1, at: T(3) })],
    });
    expect((await scanClaudeCodeLogs({ basePath: base })).map((e) => e.externalId).sort()).toEqual(["r_sub", "r_top", "r_wf"]);
  });
});

describe("usage extras: fast mode and web-search requests (carried, priced by the server later)", () => {
  const line = (o: { rid: string; at: string; speed?: unknown; web?: unknown; out?: number }) =>
    JSON.stringify({
      type: "assistant", requestId: o.rid, timestamp: o.at, sessionId: "s",
      message: { id: `m_${o.rid}`, model: "m", usage: { input_tokens: 1, output_tokens: o.out ?? 1, ...(o.speed !== undefined ? { speed: o.speed } : {}), ...(o.web !== undefined ? { server_tool_use: { web_search_requests: o.web } } : {}) } },
    });
  const scan = async (lines: string[]) => {
    const base = await mkdtemp(join(tmpdir(), "centrail-extras-"));
    await mkdir(join(base, "p"), { recursive: true });
    await writeFile(join(base, "p", "s.jsonl"), `${lines.join("\n")}\n`);
    return (await scanClaudeCodeLogs({ basePath: base })).map((e) => [e.externalId, e.speed, e.webSearchRequests]);
  };

  it.each([
    ["standard speed, no searches", [line({ rid: "r", at: T(1), speed: "standard" })], [["r", "standard", undefined]]],
    ["fast on a later streamed line wins", [line({ rid: "r", at: T(1), speed: "standard" }), line({ rid: "r", at: T(2), speed: "fast" })], [["r", "fast", undefined]]],
    ["web searches grow across lines: the max", [line({ rid: "r", at: T(1), web: 1 }), line({ rid: "r", at: T(2), web: 3 }), line({ rid: "r", at: T(3), web: 2 })], [["r", undefined, 3]]],
    ["zero searches are absent, not 0", [line({ rid: "r", at: T(1), web: 0 })], [["r", undefined, undefined]]],
    ["malformed values are absent", [line({ rid: "r", at: T(1), speed: 7, web: -2 })], [["r", undefined, undefined]]],
    ["no usage extras at all (older Claude Code)", [line({ rid: "r", at: T(1) })], [["r", undefined, undefined]]],
  ])("%s", async (_, lines, expected) => {
    expect(await scan(lines)).toEqual(expected);
  });
});
