import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedUsageEvent } from "./claude-code.js";

// Pi's persisted assistant usage has disjoint input/output/cache buckets.
// Reasoning is already inside output. Titles, prompts, response text and costs
// are intentionally not projected. Descendant tools need their own discovery
// and compatibility tests before sharing this reader.
export function piSessionsDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  const agentDir = configured === "~" ? homedir()
    : configured?.startsWith("~/") || configured?.startsWith("~\\") ? join(homedir(), configured.slice(2))
    : configured || join(homedir(), ".pi", "agent");
  return join(agentDir, "sessions");
}

type RecordObject = Record<string, unknown>;
function object(value: unknown): value is RecordObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 240 && !/[\u0000-\u001F\u007F\uD800-\uDFFF\uFFFD]/u.test(value);
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
}

async function filesUnder(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    // Do not follow symlinks into unrelated trees or cycles.
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

type PiScanIssue = { reason: "conflicting_usage" | "invalid_usage"; externalId: string };
function parseFile(bytes: Buffer, onIssue?: (issue: PiScanIssue) => void): ParsedUsageEvent[] {
  let session: RecordObject | undefined;
  const events: ParsedUsageEvent[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(10, start);
    const end = newline === -1 ? bytes.length : newline;
    const rawLine = bytes.subarray(start, end);
    start = end + 1;
    let line: string;
    try { line = decoder.decode(rawLine); } catch { continue; }
    if (!line.trim()) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!object(entry)) continue;
    if (!session) {
      if (entry.type === "title") continue;
      if (entry.type !== "session" || !text(entry.id)) return [];
      session = entry;
      continue;
    }
    if (entry.type !== "message" || !object(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "assistant") continue;
    const invalid = () => onIssue?.({ reason: "invalid_usage", externalId: "pi:unidentified" });
    if (!object(message.usage)) { invalid(); continue; }
    const usage = message.usage;
    // Missing or malformed counters are unknown, not observed zeroes.
    if (![usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(count)) { invalid(); continue; }
    if (usage.cacheWrite1h !== undefined && (!count(usage.cacheWrite1h) || usage.cacheWrite1h > (usage.cacheWrite as number))) { invalid(); continue; }
    if (!text(message.model) || !text(message.provider) || !text(entry.timestamp)) { invalid(); continue; }
    const occurredAt = new Date(entry.timestamp);
    if (!Number.isFinite(occurredAt.getTime())) { invalid(); continue; }
    if (!text(message.responseId) && !text(entry.id)) { invalid(); continue; }
    const identity = text(message.responseId)
      ? ["response", message.provider, message.responseId]
      : ["entry", message.provider, message.model, entry.id, occurredAt.toISOString()];
    // Forks copy entries into a different session. Neither path nor session
    // participates; mutable usage does not mint a new event on correction.
    const externalId = `pi:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
    events.push({
      externalId,
      provider: message.provider,
      model: message.model,
      inputTokens: usage.input as number,
      outputTokens: usage.output as number,
      cacheReadTokens: usage.cacheRead as number,
      cacheWriteTokens: (usage.cacheWrite as number) - (message.provider === "anthropic" ? (usage.cacheWrite1h as number | undefined) ?? 0 : 0),
      cacheCreationTokens: usage.cacheWrite as number,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: (usage.cacheWrite1h as number | undefined) ?? 0,
      occurredAt,
      metadata: {
        sessionId: `pi:${session.id as string}`,
        ...(text(session.cwd) ? { cwd: session.cwd } : {}),
        ...(text(entry.id) ? { messageId: entry.id } : {}),
      },
    });
  }
  return events;
}

export async function scanPiLogs(opts: {
  basePath?: string;
  since?: Date;
  wholeFiles?: boolean;
  onFile?: (done: number, total: number) => void;
  onIssue?: (issue: PiScanIssue) => void;
} = {}): Promise<ParsedUsageEvent[]> {
  const files = await filesUnder(opts.basePath ?? piSessionsDir());
  const events: ParsedUsageEvent[] = [];
  const seen = new Set<string>();
  const identities = new Map<string, string>();
  const conflicts = new Set<string>();
  const selected = new Set<string>();
  for (const [index, path] of files.entries()) {
    try {
      const info = await stat(path);
      // ctime also catches a newly copied historical transcript whose mtime
      // was preserved. Every record of a changed file is safe replay evidence.
      const changed = !opts.since || Math.max(info.mtimeMs, info.ctimeMs) >= opts.since.getTime();
      // A fork can preserve response identity under another session header.
      // Compare all files in the chosen store; the watermark selects output
      // identities, never which copies are allowed to contradict them.
      for (const event of parseFile(await readFile(path), changed ? opts.onIssue : undefined)) {
        if (changed) selected.add(event.externalId);
        const fingerprint = JSON.stringify([
          event.externalId, event.model, event.occurredAt.toISOString(),
          event.inputTokens, event.outputTokens, event.cacheReadTokens, event.cacheWriteTokens,
          event.cacheCreation1hTokens,
        ]);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        const previous = identities.get(event.externalId);
        if (previous && previous !== fingerprint) {
          conflicts.add(event.externalId);
        }
        identities.set(event.externalId, fingerprint);
        events.push(event);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      opts.onFile?.(index + 1, files.length);
    }
  }
  for (const externalId of conflicts) {
    if (selected.has(externalId)) opts.onIssue?.({ reason: "conflicting_usage", externalId });
  }
  // Conflicting evidence cannot safely become the ingest path's maxima.
  return events.filter((event) => selected.has(event.externalId) && !conflicts.has(event.externalId));
}
