import { appendFile, copyFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { geminiSessionsDirs, scanGeminiLogs, type GeminiScanIssue } from "../src/providers/gemini.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const timestamp = "2026-01-01T00:00:00.000Z";
const header = { sessionId: "source-session", projectHash: "opaque", startTime: timestamp,
  directories: ["/PRIVATE/PATH"], summary: "PRIVATE SUMMARY" };
function message(id = "source-message", tokens: Record<string, unknown> = {}) {
  return { id, type: "gemini", model: "gemini-2.5-pro", timestamp, content: "PRIVATE RESPONSE",
    thoughts: [{ subject: "PRIVATE THOUGHT" }],
    tokens: { input: 100, output: 20, cached: 30, thoughts: 10, tool: 0, total: 130, ...tokens } };
}
async function fixture(records: unknown[], jsonl = true) {
  const root = await mkdtemp(join(tmpdir(), "centrail-gemini-"));
  roots.push(root);
  const file = join(root, "project/chats", `session-test.${jsonl ? "jsonl" : "json"}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, jsonl ? [header, ...records].map((record) => JSON.stringify(record)).join("\n") + "\n"
    : JSON.stringify({ ...header, messages: records }));
  return { root, file };
}

describe("Gemini recorded request evidence", () => {
  it.each([true, false])("reads %s JSONL with inclusive cache and separate reasoning exactly once", async (jsonl) => {
    const { root } = await fixture([message()], jsonl);
    const events = await scanGeminiLogs({ basePath: root });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: "google", model: "gemini-2.5-pro",
      inputTokens: 70, outputTokens: 30, cacheReadTokens: 30, cacheWriteTokens: 0,
      metadata: { sessionId: "gemini:source-session", messageId: "source-message" } });
    expect(events[0].externalId).toMatch(/^gemini:[a-f0-9]{64}$/);
    expect(events[0].metadata.cwd).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain("PRIVATE");
  });
  it("uses latest token-bearing update while ignoring later text-only records", async () => {
    const initial = { ...message(), tokens: null };
    const { root } = await fixture([initial, message(), { ...message(), tokens: undefined }]);
    expect(await scanGeminiLogs({ basePath: root })).toHaveLength(1);
  });
  it("applies a same-file usage correction atomically instead of maximizing each field", async () => {
    const { root } = await fixture([message(), message("source-message", { input: 120, output: 5, total: 135 })]);
    const [event] = await scanGeminiLogs({ basePath: root });
    expect(event.inputTokens).toBe(90);
    expect(event.outputTokens).toBe(15);
  });
  it("retains incurred usage after rewind, removal and full-history checkpoint", async () => {
    const { root } = await fixture([
      message("before"), message("removed"), { $rewindTo: "before" },
      { $patch: { removeIds: ["removed"], updates: [{ id: "before", content: "PRIVATE EDIT" }] } },
      { $set: { messages: [message("after")], summary: "PRIVATE TITLE" } },
    ]);
    const events = await scanGeminiLogs({ basePath: root });
    expect(events.map((event) => event.metadata.messageId)).toEqual(["before", "removed", "after"]);
  });
  it("collapses copies across JSON and JSONL without collapsing distinct messages", async () => {
    const { root, file } = await fixture([message("first"), message("second")]);
    await copyFile(file, join(dirname(file), "session-copy.jsonl"));
    await writeFile(join(dirname(file), "session-legacy.json"), JSON.stringify({ ...header, messages: [message("first")] }));
    expect(await scanGeminiLogs({ basePath: root })).toHaveLength(2);
  });
  it("quarantines independently conflicting copies", async () => {
    const { root, file } = await fixture([message()]);
    await writeFile(join(dirname(file), "session-copy.json"), JSON.stringify({ ...header,
      messages: [message("source-message", { output: 25, total: 135 })] }));
    const issues: GeminiScanIssue[] = [];
    expect(await scanGeminiLogs({ basePath: root, onIssue: (issue) => issues.push(issue) })).toEqual([]);
    expect(issues.map((issue) => issue.reason)).toEqual(["conflicting_usage"]);
  });
  it.each(["a-copy", "z-copy"])("checks unchanged cross-session evidence against changed %s before incremental delivery", async (name) => {
    const { root, file } = await fixture([message("shared")]);
    const changedFile = join(dirname(file), `${name}.json`);
    await writeFile(changedFile, JSON.stringify({ ...header, sessionId: "fork", messages: [
      message("shared", { output: 25, total: 135 }), message("new"),
    ] }));
    const since = new Date(Date.now() + 1000);
    const modified = new Date(since.getTime() + 1000);
    await utimes(changedFile, modified, modified);
    const issues: GeminiScanIssue[] = [];
    const events = await scanGeminiLogs({ basePath: root, since, onIssue: (issue) => issues.push(issue) });
    expect(events.map((event) => event.metadata.messageId)).toEqual(["new"]);
    expect(issues).toEqual([{ reason: "conflicting_usage", externalId: expect.any(String) }]);
    const untouchedIssues: GeminiScanIssue[] = [];
    expect(await scanGeminiLogs({ basePath: root, since: new Date(modified.getTime() + 1000), onIssue: (issue) => untouchedIssues.push(issue) })).toEqual([]);
    expect(untouchedIssues).toEqual([]);
  });
  it("sends an unchanged identity again when an exact new copy is the changed evidence", async () => {
    const { root, file } = await fixture([message()]);
    const copied = join(dirname(file), "z-copy.jsonl");
    await copyFile(file, copied);
    const since = new Date(Date.now() + 1000);
    await utimes(copied, new Date(since.getTime() + 1000), new Date(since.getTime() + 1000));
    expect(await scanGeminiLogs({ basePath: root, since })).toHaveLength(1);
  });
  it("keeps message identity across forked session copies and file rotation", async () => {
    const { root, file } = await fixture([message()]);
    const before = (await scanGeminiLogs({ basePath: root }))[0];
    await writeFile(file, JSON.stringify({ ...header, sessionId: "fork" }) + "\n" + JSON.stringify(message()) + "\n");
    await rename(file, join(dirname(file), "session-rotated.jsonl"));
    expect((await scanGeminiLogs({ basePath: root }))[0].externalId).toBe(before.externalId);
  });
  it("finishes a partial append without forgetting completed records", async () => {
    const { root, file } = await fixture([message("first")]);
    const second = JSON.stringify(message("second"));
    await appendFile(file, second.slice(0, -3));
    expect(await scanGeminiLogs({ basePath: root })).toHaveLength(1);
    await appendFile(file, second.slice(-3) + "\n");
    expect(await scanGeminiLogs({ basePath: root })).toHaveLength(2);
  });
  it("returns late historical records in newly copied or corrected files", async () => {
    const { root, file } = await fixture([message()]);
    await utimes(file, new Date(timestamp), new Date(timestamp));
    const [event] = await scanGeminiLogs({ basePath: root, since: new Date("2026-02-01"), wholeFiles: true });
    expect(event.metadata.context).toBeUndefined();
  });
  it.each([1, 25])("quarantines nonzero tool prompt usage (%s) instead of guessing overlap", async (tool) => {
    const { root } = await fixture([message("source-message", { tool })]);
    const issues: GeminiScanIssue[] = [];
    expect(await scanGeminiLogs({ basePath: root, onIssue: (issue) => issues.push(issue) })).toEqual([]);
    expect(issues[0].reason).toBe("unsupported_tool_usage");
  });
  it.each([
    { input: undefined }, { cached: undefined }, { output: undefined }, { total: undefined },
    { input: -1 }, { cached: 101 }, { thoughts: -1 }, { tool: "0" }, { output: 2.5 },
    { total: 160 }, { total: 120 }, { total: null },
  ])("rejects unobserved or inconsistent token accounting %j", async (tokens) => {
    const { root } = await fixture([message("source-message", tokens)]);
    const issues: GeminiScanIssue[] = [];
    expect(await scanGeminiLogs({ basePath: root, onIssue: (issue) => issues.push(issue) })).toEqual([]);
    expect(issues[0].reason).toBe("invalid_usage");
  });
  it("supports omitted legacy optional thoughts/tool when required total proves accounting", async () => {
    const { root } = await fixture([message("source-message", { thoughts: undefined, tool: undefined, total: 120 })]);
    expect((await scanGeminiLogs({ basePath: root }))[0].outputTokens).toBe(20);
  });
  it("does not fabricate timestamp, model or message ID", async () => {
    const { root } = await fixture([
      { ...message(), id: undefined }, { ...message(), model: undefined }, { ...message(), timestamp: undefined },
      { ...message(), type: "user" },
    ]);
    expect(await scanGeminiLogs({ basePath: root })).toEqual([]);
  });
  it.each(["id", "model", "session"])("rejects database-unsafe control characters in %s", async (field) => {
    const bad = "bad\u0000value";
    const record = { ...message(), ...(field === "id" ? { id: bad } : field === "model" ? { model: bad } : {}) };
    const { root, file } = await fixture([record]);
    if (field === "session") await writeFile(file, JSON.stringify({ ...header, sessionId: bad }) + "\n" + JSON.stringify(record) + "\n");
    expect(await scanGeminiLogs({ basePath: root })).toEqual([]);
  });
  it("does not accept unrelated JSON, headless aggregate summaries or sessionless messages", async () => {
    const { root, file } = await fixture([]);
    await writeFile(file, JSON.stringify(message()) + "\n");
    await writeFile(join(root, "other.json"), JSON.stringify({ ...header, messages: [message()] }));
    await writeFile(join(root, "session-stats.json"), JSON.stringify({ session_id: "x", stats: { input: 10 } }));
    expect(await scanGeminiLogs({ basePath: root })).toEqual([]);
  });
  it("resolves actual Gemini HOME override semantics and keeps explicit basePath isolated", async () => {
    const { root } = await fixture([message()]);
    vi.stubEnv("GEMINI_CLI_HOME", root);
    expect(geminiSessionsDirs()).toEqual([join(root, ".gemini/tmp"), join(root, ".cache/.gemini/tmp")]);
    expect(await scanGeminiLogs({ basePath: join(root, "missing") })).toEqual([]);
  });
});
