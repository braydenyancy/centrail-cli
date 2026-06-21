import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

function shutdown(modelMetrics: Record<string, unknown>): string {
  return JSON.stringify({
    type: "session.shutdown",
    timestamp: "2026-06-21T21:47:17.588Z",
    data: { modelMetrics },
  });
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
  it("emits one event per model from session.shutdown modelMetrics", async () => {
    const base = await makeSession([ONE_MODEL]);
    const events = await scanCopilotLogs({ basePath: base });
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.externalId).toBe("sess-abc:gpt-5.3-codex");
    expect(e.model).toBe("gpt-5.3-codex");
    expect(e.inputTokens).toBe(149296);
    expect(e.outputTokens).toBe(1848); // reasoning NOT added
    expect(e.cacheReadTokens).toBe(119040);
    expect(e.cacheCreationTokens).toBe(0); // cacheWriteTokens
    expect(e.cacheCreation5mTokens).toBe(0);
    expect(e.cacheCreation1hTokens).toBe(0);
    expect(e.occurredAt.toISOString()).toBe("2026-06-21T21:46:11.546Z");
    expect(e.metadata.cwd).toBe("/Users/dev/myrepo");
    expect(e.metadata.gitBranch).toBe("main");
    expect(e.metadata.sessionId).toBe("sess-abc");
  });

  it("emits one event per model when a session used two makers", async () => {
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

  it("skips an in-progress session with no session.shutdown line", async () => {
    const base = await makeSession([JSON.stringify({ type: "assistant.message", data: { outputTokens: 5 } })]);
    expect(await scanCopilotLogs({ basePath: base })).toHaveLength(0);
  });

  it("returns [] when the base path does not exist", async () => {
    expect(await scanCopilotLogs({ basePath: "/no/such/dir/xyz" })).toHaveLength(0);
  });

  it("honors `since` against the session created_at", async () => {
    const base = await makeSession([ONE_MODEL]);
    expect(await scanCopilotLogs({ basePath: base, since: new Date("2026-06-22T00:00:00.000Z") })).toHaveLength(0);
    expect(await scanCopilotLogs({ basePath: base, since: new Date("2026-06-20T00:00:00.000Z") })).toHaveLength(1);
  });
});
