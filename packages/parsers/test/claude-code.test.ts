import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readClaudeCodeAccount, scanClaudeCodeLogs } from "../src/index.js";

const ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  requestId: "req_001",
  timestamp: "2026-06-01T12:00:00.000Z",
  cwd: "/Users/dev/myrepo",
  gitBranch: "main",
  sessionId: "sess-1",
  version: "2.0.0",
  entrypoint: "claude-vscode",
  message: {
    model: "claude-opus-4-8",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 300,
      cache_creation: {
        ephemeral_5m_input_tokens: 100,
        ephemeral_1h_input_tokens: 200,
      },
    },
  },
});

async function makeBase(): Promise<string> {
  return mkdtemp(join(tmpdir(), "centrail-parsers-"));
}

async function writeSession(
  base: string,
  project: string,
  file: string,
  lines: string[],
): Promise<void> {
  const dir = join(base, project);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), `${lines.join("\n")}\n`);
}

describe("scanClaudeCodeLogs", () => {
  it("parses an assistant event with the full usage breakdown", async () => {
    const base = await makeBase();
    await writeSession(base, "-Users-dev-myrepo", "a.jsonl", [ASSISTANT_LINE]);

    const events = await scanClaudeCodeLogs({ basePath: base });

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.externalId).toBe("req_001");
    expect(e.provider).toBe("anthropic");
    expect(e.model).toBe("claude-opus-4-8");
    expect(e.inputTokens).toBe(100);
    expect(e.outputTokens).toBe(50);
    expect(e.cacheReadTokens).toBe(2000);
    expect(e.cacheCreationTokens).toBe(300);
    expect(e.cacheCreation5mTokens).toBe(100);
    expect(e.cacheCreation1hTokens).toBe(200);
    expect(e.occurredAt.toISOString()).toBe("2026-06-01T12:00:00.000Z");
    expect(e.metadata.cwd).toBe("/Users/dev/myrepo");
    expect(e.metadata.gitBranch).toBe("main");
    expect(e.metadata.sessionId).toBe("sess-1");
    expect(e.metadata.origin?.client).toBe("claude-vscode");
  });

  it("skips non-assistant lines, synthetic models, malformed JSON, missing requestId, and missing usage block", async () => {
    const base = await makeBase();
    const synthetic = JSON.parse(ASSISTANT_LINE);
    synthetic.requestId = "req_syn";
    synthetic.message.model = "<synthetic>";
    const noRequestId = JSON.parse(ASSISTANT_LINE);
    delete noRequestId.requestId;
    await writeSession(base, "p", "a.jsonl", [
      JSON.stringify({ type: "user", text: "hi" }),
      "not json {{{",
      JSON.stringify(synthetic),
      JSON.stringify(noRequestId),
      JSON.stringify({
        type: "assistant",
        requestId: "req_nousage",
        timestamp: "2026-06-01T12:00:00.000Z",
        message: { model: "claude-opus-4-8" },
      }),
      ASSISTANT_LINE,
    ]);

    const events = await scanClaudeCodeLogs({ basePath: base });

    expect(events.map((e) => e.externalId)).toEqual(["req_001"]);
  });

  it("excludes events at or before `since` by occurredAt", async () => {
    const base = await makeBase();
    await writeSession(base, "p", "a.jsonl", [ASSISTANT_LINE]);

    // `since` is 1s in the future: the fixture's mtime is "now" so the file
    // is skipped by the mtime guard, and even if it were read, the event's
    // 2026-06-01 timestamp fails `occurredAt > since`. Either path must
    // yield zero events, with no dependence on what year the test runs in.
    const events = await scanClaudeCodeLogs({
      basePath: base,
      since: new Date(Date.now() + 1000),
    });

    expect(events).toHaveLength(0);
  });

  it("returns [] when the base path does not exist", async () => {
    const events = await scanClaudeCodeLogs({
      basePath: join(await makeBase(), "nested-missing"),
    });
    expect(events).toEqual([]);
  });

  it("ignores non-jsonl files and bare files at the top level", async () => {
    const base = await makeBase();
    await writeSession(base, "p", "notes.txt", ["hello"]);
    await writeFile(join(base, "stray.jsonl"), `${ASSISTANT_LINE}\n`);

    const events = await scanClaudeCodeLogs({ basePath: base });

    expect(events).toEqual([]);
  });

  it("defaults the 5m/1h cache split to 0 when cache_creation is absent", async () => {
    const base = await makeBase();
    const line = JSON.parse(ASSISTANT_LINE);
    line.requestId = "req_nosplit";
    delete line.message.usage.cache_creation;
    await writeSession(base, "p", "a.jsonl", [JSON.stringify(line)]);

    const events = await scanClaudeCodeLogs({ basePath: base });

    expect(events).toHaveLength(1);
    expect(events[0].cacheCreationTokens).toBe(300);
    expect(events[0].cacheCreation5mTokens).toBe(0);
    expect(events[0].cacheCreation1hTokens).toBe(0);
  });
});

describe("readClaudeCodeAccount", () => {
  it("reads the oauthAccount block", async () => {
    const base = await makeBase();
    const file = join(base, "claude.json");
    await writeFile(
      file,
      JSON.stringify({
        oauthAccount: {
          accountUuid: "acct-123",
          emailAddress: "dev@example.com",
          organizationUuid: "org-1",
          billingType: "max_20x",
        },
      }),
    );

    const account = await readClaudeCodeAccount(file);

    expect(account).toEqual({
      accountUuid: "acct-123",
      emailAddress: "dev@example.com",
      organizationUuid: "org-1",
      billingType: "max_20x",
    });
  });

  it("returns null for missing file or missing oauthAccount", async () => {
    const base = await makeBase();
    expect(await readClaudeCodeAccount(join(base, "nope.json"))).toBeNull();
    const file = join(base, "claude.json");
    await writeFile(file, JSON.stringify({ somethingElse: true }));
    expect(await readClaudeCodeAccount(file)).toBeNull();
  });
});
