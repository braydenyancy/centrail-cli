import { appendFile, copyFile, mkdir, mkdtemp, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { piSessionsDir, scanPiLogs } from "../src/providers/pi.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const timestamp = "2026-01-01T00:00:00.000Z";
function message(id = "entry-1", extra: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) {
  return { type: "message", id, timestamp, message: {
    role: "assistant", provider: "anthropic", model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "PRIVATE RESPONSE" }],
    ...extra,
    usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 7, ...usage },
  } };
}
async function fixture(records: unknown[] = [message()], session = "session-1") {
  const root = await mkdtemp(join(tmpdir(), "centrail-pi-"));
  roots.push(root);
  const file = await transcript(root, "workspace/original.jsonl", records, session);
  return { root, file };
}
async function transcript(root: string, relative: string, records: unknown[], session: string) {
  const file = join(root, relative);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, [
    { type: "session", version: 3, id: session, timestamp, cwd: "/local/project", title: "PRIVATE TITLE" },
    ...records,
  ].map(JSON.stringify).join("\n") + "\n");
  return file;
}
describe("Pi request evidence", () => {
  it("discovers the explicit Pi agent directory while keeping basePath isolated", async () => {
    const { root } = await fixture([]);
    vi.stubEnv("PI_CODING_AGENT_DIR", root);
    await transcript(root, "sessions/workspace/current.jsonl", [message()], "configured");
    expect(piSessionsDir()).toBe(join(root, "sessions"));
    expect(await scanPiLogs()).toHaveLength(1);
    expect(await scanPiLogs({ basePath: join(root, "absent") })).toEqual([]);
  });
  it("reports malformed usage without echoing private fields", async () => {
    const { root } = await fixture([message("PRIVATE ID", {}, { input: undefined })]);
    const issues: unknown[] = [];
    expect(await scanPiLogs({ basePath: root, onIssue: (issue) => issues.push(issue) })).toEqual([]);
    expect(issues).toEqual([{ reason: "invalid_usage", externalId: "pi:unidentified" }]);
  });
  it("preserves observed disjoint buckets, original identities and local placement without text", async () => {
    const { root } = await fixture([
      { type: "message", message: { role: "user", content: "PRIVATE PROMPT" } },
      message("entry-1", {}, { cacheWrite1h: 15 }),
    ]);
    const [event] = await scanPiLogs({ basePath: root });
    expect(event).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6", inputTokens: 10,
      outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40, cacheWriteTokens: 25,
      cacheCreation5mTokens: 0, cacheCreation1hTokens: 15,
      metadata: { sessionId: "pi:session-1", messageId: "entry-1", cwd: "/local/project" } });
    expect(event.externalId).toMatch(/^pi:[a-f0-9]{64}$/);
    expect(JSON.stringify(event)).not.toContain("PRIVATE");
  });
  it.each(["openrouter", "azure", "openai-codex", "custom-route"])("preserves %s rather than deriving a model vendor", async (provider) => {
    const { root } = await fixture([message("a", { provider })]);
    expect((await scanPiLogs({ basePath: root }))[0].provider).toBe(provider);
  });
  it.each([0, 15, 40])("keeps Anthropic unknown-duration residual separate from explicit 1h %s", async (cacheWrite1h) => {
    const { root } = await fixture([message("entry", {}, { cacheWrite1h })]);
    const [event] = await scanPiLogs({ basePath: root });
    expect(event.cacheCreationTokens).toBe(40);
    expect(event.cacheWriteTokens).toBe(40 - cacheWrite1h);
    expect(event.cacheCreation1hTokens).toBe(cacheWrite1h);
  });
  it.each(["\ud800", "x".repeat(300)])("rejects invalid or oversized source identifiers", async (id) => {
    const { root } = await fixture([message(id)]);
    expect(await scanPiLogs({ basePath: root })).toEqual([]);
  });
  it("rejects counters outside ingest limits", async () => {
    const { root } = await fixture([message("entry", {}, { input: 1_000_000_001 })]);
    expect(await scanPiLogs({ basePath: root })).toEqual([]);
  });
  it.each(["id", "model", "session"])("rejects database-unsafe control characters in %s", async (field) => {
    const bad = "bad\u0000value";
    const record = message(field === "id" ? bad : "entry", field === "model" ? { model: bad } : {});
    const { root } = await fixture([record], field === "session" ? bad : "session");
    expect(await scanPiLogs({ basePath: root })).toEqual([]);
  });
  it("collapses copied files and copied fork prefixes while retaining genuine new calls", async () => {
    const original = message("a", { responseId: "response-1" });
    const { root, file } = await fixture([original]);
    await copyFile(file, join(root, "workspace/copy.jsonl"));
    await transcript(root, "workspace/fork.jsonl", [original, message("b", { responseId: "response-2" })], "fork");
    expect(await scanPiLogs({ basePath: root })).toHaveLength(2);
  });
  it("deduplicates a fork without response IDs and keeps unrelated colliding short IDs separate", async () => {
    const { root } = await fixture([message("deadbeef")]);
    const other = { ...message("deadbeef"), timestamp: "2026-01-01T00:00:01.000Z" };
    await transcript(root, "workspace/fork.jsonl", [message("deadbeef"), other], "fork");
    expect(await scanPiLogs({ basePath: root })).toHaveLength(2);
  });
  it("namespaces response identity by provider", async () => {
    const { root } = await fixture([
      message("a", { responseId: "same", provider: "azure" }),
      message("b", { responseId: "same", provider: "openai" }),
    ]);
    expect(await scanPiLogs({ basePath: root })).toHaveLength(2);
  });
  it("quarantines contradictory records without synthesizing a token maximum", async () => {
    const { root } = await fixture([
      message("a", { responseId: "same" }, { input: 10, output: 100 }),
      message("a", { responseId: "same" }, { input: 100, output: 10 }),
    ]);
    const issues: unknown[] = [];
    expect(await scanPiLogs({ basePath: root, onIssue: (issue) => issues.push(issue) })).toEqual([]);
    expect(issues).toEqual([{ reason: "conflicting_usage", externalId: expect.stringMatching(/^pi:/) }]);
  });
  it.each(["a-copy", "z-copy"])("checks unchanged cross-session evidence against changed %s before incremental delivery", async (name) => {
    const { root } = await fixture([message("shared", { responseId: "same" })]);
    const changedFile = await transcript(root, `workspace/${name}.jsonl`, [
      message("shared", { responseId: "same" }, { input: 11 }),
      message("new", { responseId: "new" }),
    ], "fork");
    const since = new Date(Date.now() + 1000);
    const modified = new Date(since.getTime() + 1000);
    await utimes(changedFile, modified, modified);
    const issues: unknown[] = [];
    const events = await scanPiLogs({ basePath: root, since, onIssue: (issue) => issues.push(issue) });
    expect(events.map((event) => event.metadata.messageId)).toEqual(["new"]);
    expect(issues).toEqual([{ reason: "conflicting_usage", externalId: expect.any(String) }]);
    const untouchedIssues: unknown[] = [];
    expect(await scanPiLogs({ basePath: root, since: new Date(modified.getTime() + 1000), onIssue: (issue) => untouchedIssues.push(issue) })).toEqual([]);
    expect(untouchedIssues).toEqual([]);
  });
  it("sends an unchanged identity again when an exact new copy is the changed evidence", async () => {
    const { root, file } = await fixture();
    const copied = join(root, "workspace/z-copy.jsonl");
    await copyFile(file, copied);
    const since = new Date(Date.now() + 1000);
    await utimes(copied, new Date(since.getTime() + 1000), new Date(since.getTime() + 1000));
    expect(await scanPiLogs({ basePath: root, since })).toHaveLength(1);
  });
  it("keeps identity stable after token correction and file rotation", async () => {
    const { root, file } = await fixture();
    const before = (await scanPiLogs({ basePath: root }))[0];
    await transcript(root, "workspace/original.jsonl", [message("entry-1", {}, { input: 11 })], "session-1");
    await rename(file, join(root, "workspace/rotated.jsonl"));
    const after = (await scanPiLogs({ basePath: root }))[0];
    expect(after.externalId).toBe(before.externalId);
    expect(after.inputTokens).toBe(11);
  });
  it("replays newly copied historical events even with preserved old mtime", async () => {
    const { root, file } = await fixture();
    await utimes(file, new Date(timestamp), new Date(timestamp));
    expect(await scanPiLogs({ basePath: root, since: new Date("2026-02-01") })).toHaveLength(1);
  });
  it("returns old corrections in changed files as replayable rather than context-only", async () => {
    const { root } = await fixture();
    const [event] = await scanPiLogs({ basePath: root, since: new Date("2026-02-01"), wholeFiles: true });
    expect(event.metadata.context).toBeUndefined();
  });
  it("recovers a completed partial append without changing prior identity", async () => {
    const { root, file } = await fixture();
    const second = JSON.stringify(message("second"));
    await appendFile(file, second.slice(0, -5));
    const first = await scanPiLogs({ basePath: root });
    expect(first).toHaveLength(1);
    await appendFile(file, second.slice(-5) + "\n");
    const completed = await scanPiLogs({ basePath: root });
    expect(completed).toHaveLength(2);
    expect(completed[0].externalId).toBe(first[0].externalId);
  });
  it("skips a damaged UTF-8 record without dropping unrelated evidence", async () => {
    const { root, file } = await fixture();
    await appendFile(file, Buffer.concat([Buffer.from('{"type":"message","id":"'), Buffer.from([0xff]), Buffer.from('"}\n')]));
    await appendFile(file, JSON.stringify(message("second")) + "\n");
    expect(await scanPiLogs({ basePath: root })).toHaveLength(2);
  });
  it.each([undefined, null, -1, 1.5, "10", Number.MAX_SAFE_INTEGER + 1])("does not manufacture zero for invalid usage %s", async (input) => {
    const { root } = await fixture([message("a", {}, { input })]);
    expect(await scanPiLogs({ basePath: root })).toEqual([]);
  });
  it.each(["input", "output", "cacheRead", "cacheWrite"])("requires observed %s", async (bucket) => {
    const entry = message();
    delete (entry.message.usage as Record<string, unknown>)[bucket];
    const { root } = await fixture([entry]);
    expect(await scanPiLogs({ basePath: root })).toEqual([]);
  });
  it("retains explicit zero observed counters", async () => {
    const { root } = await fixture([message("a", {}, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })]);
    expect(await scanPiLogs({ basePath: root })).toHaveLength(1);
  });
  it.each([-1, 41, "4"])("rejects invalid 1h cache subset %s", async (cacheWrite1h) => {
    const { root } = await fixture([message("a", {}, { cacheWrite1h })]);
    expect(await scanPiLogs({ basePath: root })).toEqual([]);
  });
  it("does not use file mtime for missing timestamp or invent record identity", async () => {
    const { root } = await fixture([{ ...message(), timestamp: undefined }, { ...message(), id: undefined }]);
    expect(await scanPiLogs({ basePath: root })).toEqual([]);
  });
  it("ignores session summaries, arbitrary extension usage and non-assistant records", async () => {
    const { root } = await fixture([
      { type: "compaction", usage: { input: 1 } }, { type: "usage", usage: { input: 1 } },
      message("a", { role: "user" }), message("b", { role: "toolResult" }),
    ]);
    expect(await scanPiLogs({ basePath: root })).toEqual([]);
  });
  it("does not follow symlinks out of the selected tree", async () => {
    const outside = await fixture();
    const inside = await fixture([]);
    await symlink(outside.root, join(inside.root, "linked"), "junction");
    expect(await scanPiLogs({ basePath: inside.root })).toEqual([]);
  });
  it("reports file progress and accepts an absent store", async () => {
    const { root } = await fixture();
    const progress: number[][] = [];
    await scanPiLogs({ basePath: root, onFile: (done, total) => progress.push([done, total]) });
    expect(progress).toEqual([[1, 1]]);
    expect(await scanPiLogs({ basePath: join(root, "missing") })).toEqual([]);
  });
});
