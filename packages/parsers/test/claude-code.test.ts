import { chmod, mkdir, mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readClaudeCodeAccount,
  scanClaudeCodeLogs,
  claudeConfigDirs,
  claudeProjectDirs,
} from "../src/index.js";

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
    expect(e.metadata.entrypoint).toBe("claude-vscode");
    expect(e.metadata.origin).toBeUndefined();
  });

  it("skips non-assistant lines, synthetic models, malformed JSON, missing ids, and missing usage block", async () => {
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

  it("collapses the lines of one request to one event holding the per-field max", async () => {
    // Claude Code writes one line per content block; output_tokens grows
    // across them (streamed-so-far). First-wins undercounted output by 36.7%
    // on a real corpus; the max equals the final line.
    const base = await makeBase();
    const first = JSON.parse(ASSISTANT_LINE);
    first.message.usage.output_tokens = 5;
    first.timestamp = "2026-06-01T12:00:01.000Z";
    const last = JSON.parse(ASSISTANT_LINE);
    last.message.usage.output_tokens = 140;
    await writeSession(base, "p", "a.jsonl", [JSON.stringify(first), JSON.stringify(last)]);

    const events = await scanClaudeCodeLogs({ basePath: base });

    expect(events).toHaveLength(1);
    expect(events[0].outputTokens).toBe(140);
    expect(events[0].inputTokens).toBe(100);
    expect(events[0].occurredAt.toISOString()).toBe("2026-06-01T12:00:00.000Z");
  });

  it("collapses the same request across files — a resumed session copies the prefix", async () => {
    const base = await makeBase();
    const early = JSON.parse(ASSISTANT_LINE);
    early.message.usage.output_tokens = 5;
    const final = JSON.parse(ASSISTANT_LINE);
    final.message.usage.output_tokens = 140;
    await writeSession(base, "p", "original.jsonl", [JSON.stringify(early)]);
    await writeSession(base, "p", "resumed.jsonl", [JSON.stringify(final)]);

    const events = await scanClaudeCodeLogs({ basePath: base });

    expect(events).toHaveLength(1);
    expect(events[0].outputTokens).toBe(140);
  });

  it("collapses a resumed session's copy when requestId is absent too — gateways strip it", async () => {
    // A resumed session copies earlier responses into its own file under its
    // own sessionId (1,174 such copies on one real corpus). requestId folds
    // them; the message-id fallback must too, or every gateway user (Bedrock,
    // Vertex, proxies) counts a resumed session's history twice.
    const base = await makeBase();
    const original = JSON.parse(ASSISTANT_LINE);
    delete original.requestId;
    original.message.id = "msg_01";
    original.message.usage.output_tokens = 5;
    const copy = JSON.parse(JSON.stringify(original));
    copy.sessionId = "sess-resumed";
    copy.message.usage.output_tokens = 140;
    await writeSession(base, "p", "original.jsonl", [JSON.stringify(original)]);
    await writeSession(base, "p", "resumed.jsonl", [JSON.stringify(copy)]);

    const events = await scanClaudeCodeLogs({ basePath: base });

    expect(events.map((e) => [e.externalId, e.outputTokens])).toEqual([["msg:msg_01", 140]]);
  });

  it("falls back to the message id when requestId is absent — never the timestamp, never the session", async () => {
    // Every content block of one response is its own line with its own
    // timestamp; the key must fold them. A copy under another session (a
    // resume) is the same response, so it folds too.
    const base = await makeBase();
    const a = JSON.parse(ASSISTANT_LINE);
    delete a.requestId;
    a.message.id = "msg_01";
    const b = JSON.parse(JSON.stringify(a));
    b.timestamp = "2026-06-01T12:00:03.000Z";
    b.message.usage.output_tokens = 120;
    const c = JSON.parse(JSON.stringify(a));
    c.sessionId = "sess-2";
    await writeSession(base, "p", "a.jsonl", [JSON.stringify(a), JSON.stringify(b), JSON.stringify(c)]);

    const events = await scanClaudeCodeLogs({ basePath: base });

    expect(events.map((e) => [e.externalId, e.outputTokens])).toEqual([["msg:msg_01", 120]]);
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

  it("counts subagent transcripts under <session>/subagents/", async () => {
    const base = await makeBase();
    const sub = JSON.parse(ASSISTANT_LINE);
    sub.requestId = "req_subagent";
    await writeSession(base, "p", "sess-1.jsonl", [ASSISTANT_LINE]);
    await writeSession(base, join("p", "sess-1", "subagents"), "agent-a1.jsonl", [
      JSON.stringify(sub),
    ]);
    // Only the subagents/ layout is a transcript; a stray nested file is not.
    await writeSession(base, join("p", "sess-1"), "notes.jsonl", [ASSISTANT_LINE]);

    const events = await scanClaudeCodeLogs({ basePath: base });

    expect(events.map((e) => e.externalId).sort()).toEqual(["req_001", "req_subagent"]);
  });

  it("counts off the files it reads: onFile(done, total) after each transcript, subagents included, files `since` skips not counted", async () => {
    const base = await makeBase();
    await writeSession(base, "p1", "a.jsonl", [ASSISTANT_LINE]);
    await writeSession(base, "p2", "b.jsonl", [ASSISTANT_LINE]);
    await writeSession(base, join("p2", "b", "subagents"), "agent-a1.jsonl", [ASSISTANT_LINE]);
    await writeSession(base, "p3", "old.jsonl", [ASSISTANT_LINE]);
    const old = new Date("2026-06-01T00:00:00.000Z");
    await utimes(join(base, "p3", "old.jsonl"), old, old);

    const calls: [number, number][] = [];
    const onFile = (done: number, total: number) => void calls.push([done, total]);
    const events = await scanClaudeCodeLogs({ basePath: base, onFile });
    expect(calls).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]]);
    expect(events).toEqual(await scanClaudeCodeLogs({ basePath: base })); // reporting changes nothing read

    calls.length = 0;
    await scanClaudeCodeLogs({ basePath: base, since: new Date("2026-06-02T00:00:00.000Z"), onFile });
    expect(calls).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it("counts workflow subagents nested below the known subagents root", async () => {
    const base = await makeBase();
    const nested = JSON.parse(ASSISTANT_LINE);
    nested.requestId = "req_workflow_subagent";
    nested.message.model = "claude-fable-5-1";
    await writeSession(
      base,
      join("p", "sess-1", "subagents", "workflows", "wf-1"),
      "agent-a1.jsonl",
      [JSON.stringify(nested)],
    );

    const events = await scanClaudeCodeLogs({ basePath: base });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      externalId: "req_workflow_subagent",
      model: "claude-fable-5-1",
    });
  });

  it("passes through unfamiliar model names without an allowlist", async () => {
    const base = await makeBase();
    const future = JSON.parse(ASSISTANT_LINE);
    future.requestId = "req_future";
    future.message.model = "claude-next-2099";
    await writeSession(base, "p", "future.jsonl", [JSON.stringify(future)]);

    const events = await scanClaudeCodeLogs({ basePath: base });

    expect(events.map((event) => event.model)).toEqual(["claude-next-2099"]);
  });

  it("keeps the most complete streaming snapshot for one request", async () => {
    const base = await makeBase();
    const partial = JSON.parse(ASSISTANT_LINE);
    partial.message.usage.output_tokens = 2;
    partial.timestamp = "2026-06-01T12:00:00.000Z";
    const complete = JSON.parse(ASSISTANT_LINE);
    complete.message.usage.output_tokens = 1_093;
    complete.timestamp = "2026-06-01T12:00:02.000Z";
    await writeSession(base, "p", "stream.jsonl", [
      JSON.stringify(partial),
      JSON.stringify(complete),
    ]);

    const events = await scanClaudeCodeLogs({ basePath: base });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      externalId: "req_001",
      outputTokens: 1_093,
    });
    // The most complete counts, at the request's start: the first line's
    // timestamp, whatever order the lines arrive in (collapseUsageEvents).
    expect(events[0].occurredAt.toISOString()).toBe("2026-06-01T12:00:00.000Z");
  });

  it("prefers an original response over a larger sidechain replay", async () => {
    const base = await makeBase();
    const original = JSON.parse(ASSISTANT_LINE);
    original.message.usage.output_tokens = 100;
    original.isSidechain = false;
    const replay = JSON.parse(ASSISTANT_LINE);
    replay.message.usage.output_tokens = 200;
    replay.isSidechain = true;
    replay.timestamp = "2026-06-01T12:00:02.000Z";
    await writeSession(base, "p", "replay.jsonl", [
      JSON.stringify(original),
      JSON.stringify(replay),
    ]);

    const events = await scanClaudeCodeLogs({ basePath: base });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outputTokens: 100,
      metadata: { isSidechain: false },
    });
  });

  it("does not follow symlinks out of a subagents root", async () => {
    if (process.platform === "win32") return;
    const base = await makeBase();
    const outside = await makeBase();
    const privateLine = JSON.parse(ASSISTANT_LINE);
    privateLine.requestId = "req_outside";
    await writeSession(outside, "private", "outside.jsonl", [
      JSON.stringify(privateLine),
    ]);
    const subagents = join(base, "p", "sess-1", "subagents");
    await mkdir(subagents, { recursive: true });
    await symlink(join(outside, "private"), join(subagents, "outside"));

    expect(await scanClaudeCodeLogs({ basePath: base })).toEqual([]);
  });

  it("skips a transcript it cannot read instead of aborting the scan", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return; // chmod is advisory there
    const base = await makeBase();
    const unreadable = JSON.parse(ASSISTANT_LINE);
    unreadable.requestId = "req_unreadable";
    await writeSession(base, "p", "locked.jsonl", [JSON.stringify(unreadable)]);
    await chmod(join(base, "p", "locked.jsonl"), 0o000);
    await writeSession(base, "p", "open.jsonl", [ASSISTANT_LINE]);

    const events = await scanClaudeCodeLogs({ basePath: base });

    expect(events.map((e) => e.externalId)).toEqual(["req_001"]);
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

describe("config-dir resolution (CLAUDE_CONFIG_DIR)", () => {
  const ORIG = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = ORIG;
  });

  it("defaults to ~/.claude and ~/.config/claude when unset", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    const dirs = claudeProjectDirs();
    expect(dirs.some((d) => d.endsWith(join(".claude", "projects")))).toBe(true);
    expect(dirs.some((d) => d.endsWith(join(".config", "claude", "projects")))).toBe(true);
  });

  it("with CLAUDE_CONFIG_DIR unset also reads Xcode's Claude agent config (phuryn/claude-usage scanner.py:21)", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeProjectDirs().some((d) => d.endsWith(join("Library", "Developer", "Xcode", "CodingAssistant", "ClaudeAgentConfig", "projects")))).toBe(true);
  });

  it("honors CLAUDE_CONFIG_DIR, comma-separated and trimmed", () => {
    process.env.CLAUDE_CONFIG_DIR = "/a/x ,  /b/y";
    expect(claudeConfigDirs()).toEqual(["/a/x", "/b/y"]);
    expect(claudeProjectDirs()).toEqual([
      join("/a/x", "projects"),
      join("/b/y", "projects"),
    ]);
  });

  it("an entry that IS a projects dir is scanned as one, not as <it>/projects (ccusage paths.rs)", async () => {
    const cfg = await makeBase();
    await writeSession(join(cfg, "projects"), "-Users-dev-myrepo", "a.jsonl", [ASSISTANT_LINE]);
    process.env.CLAUDE_CONFIG_DIR = join(cfg, "projects");
    expect(claudeProjectDirs()).toEqual([join(cfg, "projects")]);
    expect((await scanClaudeCodeLogs({})).map((e) => e.externalId)).toEqual(["req_001"]);
  });

  it("scanClaudeCodeLogs with no basePath reads from CLAUDE_CONFIG_DIR", async () => {
    const cfg = await makeBase();
    await writeSession(join(cfg, "projects"), "-Users-dev-myrepo", "a.jsonl", [
      ASSISTANT_LINE,
    ]);
    process.env.CLAUDE_CONFIG_DIR = cfg;

    const events = await scanClaudeCodeLogs({});

    expect(events.map((e) => e.externalId)).toEqual(["req_001"]);
  });
});

describe("a year of transcripts", () => {
  it("scans 150,000 assistant lines in one project dir without overflowing the stack", async () => {
    // `events.push(...perDir)` crashed at 177k lines on the reference machine
    // (RangeError: Maximum call stack size exceeded): a `--full` sync would
    // never complete there. Spread into a call is bounded; a loop is not.
    const base = await makeBase();
    const proto = JSON.parse(ASSISTANT_LINE);
    const lines: string[] = [];
    for (let i = 0; i < 150_000; i++) {
      proto.requestId = `req_${i}`;
      lines.push(JSON.stringify(proto));
    }
    await writeSession(base, "big", "s.jsonl", lines);
    const events = await scanClaudeCodeLogs({ basePath: base });
    expect(events).toHaveLength(150_000);
  }, 60_000);
});
