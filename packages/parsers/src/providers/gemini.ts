import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ParsedUsageEvent } from "./claude-code.js";

type ObjectRecord = Record<string, unknown>;
export type GeminiScanIssue = { reason: "conflicting_usage" | "unsupported_tool_usage" | "invalid_usage"; externalId: string };
type IssueSink = (issue: GeminiScanIssue) => void;
const isObject = (value: unknown): value is ObjectRecord => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 240 && !/[\u0000-\u001F\u007F\uD800-\uDFFF\uFFFD]/u.test(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;

export function geminiSessionsDirs(): string[] {
  // Gemini's override replaces HOME, not the .gemini directory itself.
  const home = process.env.GEMINI_CLI_HOME || homedir();
  return [join(home, ".gemini", "tmp"), join(home, ".cache", ".gemini", "tmp")];
}

async function discover(root: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await discover(path));
    else if (entry.isFile() && /\.(json|jsonl)$/.test(entry.name) &&
      (entry.name.startsWith("session-") || basename(dirname(path)) === "chats")) files.push(path);
  }
  return files;
}

function eventFor(message: ObjectRecord, sessionId: string, onIssue?: IssueSink): ParsedUsageEvent | undefined {
  if (message.type !== "gemini" || !isText(message.id) || !isText(message.model) || !isText(message.timestamp) || !isObject(message.tokens)) return;
  const occurredAt = new Date(message.timestamp);
  if (!Number.isFinite(occurredAt.getTime())) return;
  // Message ids are durable source-generated ids. Session/path do not change
  // the identity when recordings are copied or conversation history is forked.
  const externalId = `gemini:${createHash("sha256").update(JSON.stringify([message.id, message.timestamp])).digest("hex")}`;
  const tokens = message.tokens;
  const thoughts = tokens.thoughts ?? 0;
  const tool = tokens.tool ?? 0;
  if (![tokens.input, tokens.output, tokens.cached, tokens.total, thoughts, tool].every(isCount) ||
      (tokens.cached as number) > (tokens.input as number)) {
    onIssue?.({ reason: "invalid_usage", externalId });
    return;
  }
  // The API documents total=prompt+thoughts+candidates; it does not establish
  // whether tool-use prompts overlap. Do not silently add them a second time.
  if (tool !== 0) {
    onIssue?.({ reason: "unsupported_tool_usage", externalId });
    return;
  }
  const output = (tokens.output as number) + (thoughts as number);
  if (!isCount(output) || (tokens.input as number) + output !== tokens.total) {
    onIssue?.({ reason: "invalid_usage", externalId });
    return;
  }
  return {
    externalId, provider: "google", model: message.model,
    inputTokens: (tokens.input as number) - (tokens.cached as number),
    outputTokens: output, cacheReadTokens: tokens.cached as number,
    cacheCreationTokens: 0, cacheWriteTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0,
    occurredAt, metadata: { sessionId: `gemini:${sessionId}`, messageId: message.id },
  };
}

function parseRecords(bytes: Buffer, jsonl: boolean, onIssue?: IssueSink): ParsedUsageEvent[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records: unknown[] = [];
  if (!jsonl) {
    try { records.push(JSON.parse(decoder.decode(bytes))); } catch { return []; }
  } else {
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline === -1 ? bytes.length : newline;
      const line = bytes.subarray(start, end);
      start = end + 1;
      try { records.push(JSON.parse(decoder.decode(line))); } catch { /* partial or damaged append */ }
    }
  }
  let sessionId: string | undefined;
  const latest = new Map<string, ObjectRecord>();
  const recordMessage = (value: unknown) => {
    if (isObject(value) && value.type === "gemini" && isText(value.id) && isObject(value.tokens)) latest.set(value.id, value);
  };
  for (const record of records) {
    if (!isObject(record)) continue;
    const metadata = isObject(record.$set) ? record.$set : record;
    if (isText(metadata.sessionId)) {
      if (sessionId && sessionId !== metadata.sessionId) return [];
      sessionId = metadata.sessionId;
    }
    if (Array.isArray(metadata.messages)) metadata.messages.forEach(recordMessage);
    recordMessage(record);
    // $patch and $rewindTo change conversation state; they do not refund usage.
    // $set.messages checkpoints add evidence rather than erasing old records.
  }
  if (!sessionId) return [];
  return [...latest.values()].flatMap((message) => {
    const event = eventFor(message, sessionId!, onIssue);
    return event ? [event] : [];
  });
}

export async function scanGeminiLogs(opts: {
  basePath?: string;
  since?: Date;
  wholeFiles?: boolean;
  onFile?: (done: number, total: number) => void;
  onIssue?: IssueSink;
} = {}): Promise<ParsedUsageEvent[]> {
  const roots = opts.basePath === undefined ? geminiSessionsDirs() : [opts.basePath];
  const files = (await Promise.all(roots.map(discover))).flat();
  const events = new Map<string, ParsedUsageEvent>();
  const fingerprints = new Map<string, string>();
  const conflicts = new Set<string>();
  const selected = new Set<string>();
  for (const [index, file] of files.entries()) {
    try {
      const info = await stat(file);
      const changed = !opts.since || Math.max(info.mtimeMs, info.ctimeMs) >= opts.since.getTime();
      // Forks/copies can have another session id: check all source identities
      // in the explicit store before deciding which changed evidence to send.
      for (const event of parseRecords(await readFile(file), file.endsWith(".jsonl"), changed ? opts.onIssue : undefined)) {
        if (changed) selected.add(event.externalId);
        const fingerprint = JSON.stringify([event.model, event.occurredAt.toISOString(), event.inputTokens, event.outputTokens, event.cacheReadTokens]);
        const previous = fingerprints.get(event.externalId);
        if (previous && previous !== fingerprint) {
          conflicts.add(event.externalId);
        }
        fingerprints.set(event.externalId, fingerprint);
        events.set(event.externalId, event);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally { opts.onFile?.(index + 1, files.length); }
  }
  for (const externalId of conflicts) {
    if (selected.has(externalId)) opts.onIssue?.({ reason: "conflicting_usage", externalId });
  }
  return [...events.values()].filter((event) => selected.has(event.externalId) && !conflicts.has(event.externalId));
}
