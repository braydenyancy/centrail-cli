import { cp, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanCopilotLogs } from "../src/index.js";

const WORKSPACE = `id: sess-abc
cwd: /Users/dev/myrepo
git_root: /Users/dev/myrepo
repository: dev/myrepo
branch: main
created_at: 2026-06-21T21:46:11.546Z
updated_at: 2026-06-21T21:47:17.588Z
`;

function shutdown(
  modelMetrics: Record<string, unknown>,
  timestamp: string | null = "2026-06-21T21:47:17.588Z",
): string {
  const obj: Record<string, unknown> = { type: "session.shutdown", data: { modelMetrics } };
  if (timestamp !== null) obj.timestamp = timestamp;
  return JSON.stringify(obj);
}

const ONE_MODEL = shutdown({
  "gpt-5.3-codex": {
    usage: { inputTokens: 149296, outputTokens: 1848, cacheReadTokens: 119040, cacheWriteTokens: 0, reasoningTokens: 1006 },
    requests: { count: 6 },
  },
});

async function makeSession(lines: string[], workspace = WORKSPACE): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "copilot-"));
  const dir = join(base, "sess-abc");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "workspace.yaml"), workspace);
  await writeFile(join(dir, "events.jsonl"), `${lines.join("\n")}\n`);
  return base;
}

describe("scanCopilotLogs", () => {
  it("emits one event per model from a shutdown's modelMetrics, timestamped by the segment", async () => {
    const base = await makeSession([ONE_MODEL]);
    const events = await scanCopilotLogs({ basePath: base });
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.externalId).toBe("sess-abc:gpt-5.3-codex:2026-06-21T21:47:17.588Z");
    expect(e.model).toBe("gpt-5.3-codex");
    expect(e.inputTokens).toBe(149296);
    expect(e.outputTokens).toBe(1848); // reasoning NOT added
    expect(e.cacheReadTokens).toBe(119040);
    expect(e.cacheCreationTokens).toBe(0); // cacheWriteTokens
    expect(e.cacheCreation5mTokens).toBe(0);
    expect(e.cacheCreation1hTokens).toBe(0);
    expect(e.occurredAt.toISOString()).toBe("2026-06-21T21:47:17.588Z"); // segment time, not session start
    expect(e.metadata.cwd).toBe("/Users/dev/myrepo");
    expect(e.metadata.gitBranch).toBe("main");
    expect(e.metadata.sessionId).toBe("sess-abc");
  });

  it("emits one event per model when a single shutdown used two makers", async () => {
    const base = await makeSession([
      shutdown({
        "gpt-5.3-codex": { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        "claude-sonnet-4-6": { usage: { inputTokens: 20, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 3 } },
      }),
    ]);
    const events = await scanCopilotLogs({ basePath: base });
    expect(events.map((e) => e.model).sort()).toEqual(["claude-sonnet-4-6", "gpt-5.3-codex"]);
    const claude = events.find((e) => e.model === "claude-sonnet-4-6")!;
    expect(claude.cacheCreationTokens).toBe(3);
  });

  it("passes through unfamiliar model names without an allowlist", async () => {
    const base = await makeSession([
      shutdown({
        "vendor-model-next-2099": {
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      }),
    ]);

    const events = await scanCopilotLogs({ basePath: base });

    expect(events.map((event) => event.model)).toEqual(["vendor-model-next-2099"]);
  });

  it("emits one event per SEGMENT — every shutdown counts, not just the last (per-segment usage)", async () => {
    // A resumed session: two shutdowns for the same model with per-segment
    // (non-cumulative) usage. The old "last shutdown only" logic captured 250
    // and dropped the 100; both must now be present, with distinct externalIds.
    const seg = (ts: string, inTok: number) =>
      shutdown({ "gpt-5.4": { usage: { inputTokens: inTok, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } }, ts);
    const base = await makeSession([
      seg("2026-06-21T21:00:00.000Z", 100),
      seg("2026-06-21T22:00:00.000Z", 250),
    ]);
    const events = await scanCopilotLogs({ basePath: base });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.inputTokens).sort((a, b) => a - b)).toEqual([100, 250]);
    expect(new Set(events.map((e) => e.externalId)).size).toBe(2);
    expect(events.map((e) => e.externalId)).toContain("sess-abc:gpt-5.4:2026-06-21T22:00:00.000Z");
  });

  it("falls back to session created_at when a shutdown line has no timestamp", async () => {
    const base = await makeSession([
      shutdown({ "gpt-5.4": { usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } }, null),
    ]);
    const [e] = await scanCopilotLogs({ basePath: base });
    expect(e.occurredAt.toISOString()).toBe("2026-06-21T21:46:11.546Z");
    expect(e.externalId).toBe("sess-abc:gpt-5.4:2026-06-21T21:46:11.546Z");
  });

  it("skips an in-progress session with no session.shutdown line", async () => {
    const base = await makeSession([JSON.stringify({ type: "assistant.message", data: { outputTokens: 5 } })]);
    expect(await scanCopilotLogs({ basePath: base })).toHaveLength(0);
  });

  it("returns [] when the base path does not exist", async () => {
    expect(await scanCopilotLogs({ basePath: "/no/such/dir/xyz" })).toHaveLength(0);
  });

  it("sets the provider-neutral cacheWriteTokens alongside the legacy aggregate", async () => {
    const base = await makeSession([
      shutdown({
        "gpt-5.4": { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 7 } },
      }),
    ]);
    const [e] = await scanCopilotLogs({ basePath: base });
    expect(e.cacheCreationTokens).toBe(7);
    expect(e.cacheWriteTokens).toBe(7);
  });

  it("suffixes colliding externalIds so timestamp-less segments dedup independently", async () => {
    // Two shutdown segments with no timestamp both fall back to the session
    // created_at; without a suffix the server would dedup the second away.
    const seg = (inTok: number) =>
      shutdown({ "gpt-5.4": { usage: { inputTokens: inTok, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } }, null);
    const base = await makeSession([seg(100), seg(250)]);
    const events = await scanCopilotLogs({ basePath: base });
    expect(events).toHaveLength(2);
    expect(events[0].externalId).toBe("sess-abc:gpt-5.4:2026-06-21T21:46:11.546Z");
    expect(events[1].externalId).toBe("sess-abc:gpt-5.4:2026-06-21T21:46:11.546Z:2");
  });

  it("counts off the session dirs it reads: onFile(done, total) after each, a stray file included", async () => {
    const base = await makeSession([ONE_MODEL]);
    await mkdir(join(base, "sess-def"));
    await writeFile(join(base, "sess-def", "workspace.yaml"), WORKSPACE.replace("sess-abc", "sess-def"));
    await writeFile(join(base, "sess-def", "events.jsonl"), `${ONE_MODEL}\n`);
    await writeFile(join(base, "stray.txt"), "");
    const calls: [number, number][] = [];
    const events = await scanCopilotLogs({ basePath: base, onFile: (done, total) => void calls.push([done, total]) });
    expect(events).toHaveLength(2);
    expect(calls).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it("honors `since` against the segment timestamp", async () => {
    const base = await makeSession([ONE_MODEL]); // segment at 2026-06-21T21:47:17.588Z
    expect(await scanCopilotLogs({ basePath: base, since: new Date("2026-06-22T00:00:00.000Z") })).toHaveLength(0);
    expect(await scanCopilotLogs({ basePath: base, since: new Date("2026-06-20T00:00:00.000Z") })).toHaveLength(1);
  });

  it("wholeFiles replays imported historical segments and old corrections using stable IDs", async () => {
    const base = await makeSession([ONE_MODEL]);
    const path = join(base, "sess-abc", "events.jsonl");
    const old = new Date("2026-06-01");
    await utimes(path, old, old);
    const since = new Date("2026-07-01");
    const before = await scanCopilotLogs({ basePath: base, since, wholeFiles: true });
    expect(before).toHaveLength(1);
    expect(await scanCopilotLogs({ basePath: base, since, wholeFiles: true })).toEqual(before);
    const corrected = JSON.parse(ONE_MODEL);
    corrected.data.modelMetrics["gpt-5.3-codex"].usage.inputTokens = 150000;
    await writeFile(path, JSON.stringify(corrected) + "\n");
    const after = await scanCopilotLogs({ basePath: base, since, wholeFiles: true });
    expect(after).toHaveLength(1);
    expect(after[0].externalId).toBe(before[0].externalId);
    expect(after[0].inputTokens).toBe(150000);
    expect(await scanCopilotLogs({ basePath: base, since })).toEqual([]);
  });

  it("wholeFiles does not reread an unchanged store outside the file window", async () => {
    const base = await makeSession([ONE_MODEL]);
    expect(await scanCopilotLogs({ basePath: base, since: new Date(Date.now() + 1000), wholeFiles: true })).toEqual([]);
  });

  it("folds copied session directories without minting suffixes and survives deletion of either copy", async () => {
    const base = await makeSession([ONE_MODEL]);
    const before = await scanCopilotLogs({ basePath: base });
    await cp(join(base, "sess-abc"), join(base, "copy"), { recursive: true });
    expect(await scanCopilotLogs({ basePath: base })).toEqual(before);
    await rm(join(base, "sess-abc"), { recursive: true });
    expect(await scanCopilotLogs({ basePath: base })).toEqual(before);
  });

  it("quarantines conflicting copied segments including unchanged copies outside incremental window", async () => {
    const base = await makeSession([ONE_MODEL]);
    await cp(join(base, "sess-abc"), join(base, "copy"), { recursive: true });
    const corrected = JSON.parse(ONE_MODEL);
    corrected.data.modelMetrics["gpt-5.3-codex"].usage.inputTokens += 100;
    await writeFile(join(base, "copy", "events.jsonl"), JSON.stringify(corrected) + "\n");
    const since = new Date(Date.now() + 1000);
    const changed = new Date(since.getTime() + 1000);
    await utimes(join(base, "copy", "events.jsonl"), changed, changed);
    const issues: unknown[] = [];
    expect(await scanCopilotLogs({ basePath: base, since, wholeFiles: true, onIssue: (issue) => issues.push(issue) })).toEqual([]);
    expect(issues).toEqual([{ reason: "conflicting_copy", externalId: expect.any(String) }]);
  });
});
