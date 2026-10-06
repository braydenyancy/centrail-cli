// The scanner attaches, to every event, the turn it belongs to and the
// files its tool calls touched — spread over one line per content block,
// folded by the collapse. A turn starts at a human prompt (a `user` line
// whose content is not a tool result and is not meta).
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanClaudeCodeLogs } from "../src/index.js";

const T = (s: number) => `2026-06-01T12:00:${String(s).padStart(2, "0")}.000Z`;
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "user", timestamp: T(0), sessionId: "s", cwd: "/ws", message: { role: "user", content }, ...extra });
const assistant = (requestId: string, block: unknown, at: number, out = 1) =>
  JSON.stringify({
    type: "assistant",
    requestId,
    timestamp: T(at),
    sessionId: "s",
    cwd: "/ws",
    message: { id: `m_${requestId}`, model: "claude-opus-4-8", content: [block], usage: { input_tokens: 1, output_tokens: out } },
  });
const tool = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: "tu", name, input });
const toolResult = () => [{ type: "tool_result", tool_use_id: "tu", content: "ok" }];

async function scan(lines: string[]) {
  const base = await mkdtemp(join(tmpdir(), "centrail-turns-"));
  await mkdir(join(base, "p"), { recursive: true });
  await writeFile(join(base, "p", "s.jsonl"), `${lines.join("\n")}\n`);
  const events = await scanClaudeCodeLogs({ basePath: base });
  return Object.fromEntries(events.map((e) => [e.externalId, { turn: e.metadata.turn, touched: e.metadata.touched }]));
}

describe("turns and touched files", () => {
  it("numbers turns at human prompts, not at tool results or meta lines", async () => {
    const got = await scan([
      user("fix a"),
      assistant("r1", { type: "thinking", thinking: "" }, 1),
      assistant("r1", tool("Edit", { file_path: "/ws/a/x.ts" }), 2),
      user(toolResult()),
      assistant("r2", { type: "text", text: "done" }, 3),
      user("now b", { isMeta: true }), // a meta line is not a prompt
      assistant("r3", tool("Read", { file_path: "/ws/b/y.ts" }), 4),
      user("now b for real"),
      assistant("r4", tool("Bash", { command: "cd /ws/b && npm t" }), 5),
      assistant("r4", tool("Write", { file_path: "/ws/b/z.ts" }), 6),
    ]);
    expect(got.r1.turn).toBe(got.r2.turn);
    expect(got.r2.turn).toBe(got.r3.turn);
    expect(got.r4.turn).not.toBe(got.r3.turn);
    expect(got.r1.touched).toEqual({ writes: ["/ws/a/x.ts"], reads: [] });
    expect(got.r2.touched).toEqual({ writes: [], reads: [] });
    expect(got.r3.touched).toEqual({ writes: [], reads: ["/ws/b/y.ts"] });
    expect(got.r4.touched).toEqual({ writes: ["/ws/b/z.ts"], reads: ["/ws/b"] }); // folded across the request's lines
  });

  it("a transcript that starts mid-way (no user line yet) still gets a turn", async () => {
    const got = await scan([assistant("r1", tool("Read", { file_path: "/ws/a/x" }), 1)]);
    expect(got.r1.turn).toBeTruthy();
  });

  it("turns are scoped to the file, so a subagent's turn 1 is not the parent's turn 1", async () => {
    const base = await mkdtemp(join(tmpdir(), "centrail-turns-"));
    await mkdir(join(base, "p", "s", "subagents"), { recursive: true });
    await writeFile(join(base, "p", "s.jsonl"), `${[user("go"), assistant("p1", { type: "text", text: "" }, 1)].join("\n")}\n`);
    await writeFile(join(base, "p", "s", "subagents", "agent-1.jsonl"), `${[user("sub"), assistant("a1", { type: "text", text: "" }, 2)].join("\n")}\n`);
    const events = await scanClaudeCodeLogs({ basePath: base });
    const turns = Object.fromEntries(events.map((e) => [e.externalId, e.metadata.turn]));
    expect(turns.p1).not.toBe(turns.a1);
  });
});
