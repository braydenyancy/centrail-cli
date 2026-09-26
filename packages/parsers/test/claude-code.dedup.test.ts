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
