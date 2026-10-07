import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedUsageEvent } from "./claude-code.js";
import { suffixDuplicateExternalIds } from "./external-id.js";

// Scans GitHub Copilot CLI session logs. Each session lives in
// ~/.copilot/session-state/<uuid>/ with a flat `workspace.yaml` and an
// `events.jsonl`. Usage is reported in `session.shutdown` lines under
// `data.modelMetrics`, keyed by model.
//
// IMPORTANT: a session emits a NEW `session.shutdown` each time it is
// suspended/resumed, and each one reports only THAT segment's usage — the
// values are per-segment, NOT cumulative. So we emit one event per
// (shutdown-segment, model), summing nothing and dropping nothing. externalId
// includes the segment timestamp so segments dedup independently and a resumed
// session's later segments ingest as new events on the next sync.
//
// provider is left for the server to derive from the model; we set a
// best-effort value here for any local display.
//
// Pure local-filesystem code — no framework imports.

const DEFAULT_BASE_PATH = join(homedir(), ".copilot", "session-state");

export async function scanCopilotLogs(opts: {
  basePath?: string;
  since?: Date;
  onFile?: (done: number, total: number) => void;
}): Promise<ParsedUsageEvent[]> {
  const basePath = opts.basePath ?? DEFAULT_BASE_PATH;

  let entries: string[];
  try {
    entries = await readdir(basePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const events: ParsedUsageEvent[] = [];
  for (let i = 0; i < entries.length; i++) {
    await readSession(basePath, entries[i], opts.since, events);
    opts.onFile?.(i + 1, entries.length);
  }

  return suffixDuplicateExternalIds(events);
}

// Appends one session dir's events (entry: its name under the base path).
async function readSession(
  basePath: string,
  entry: string,
  since: Date | undefined,
  events: ParsedUsageEvent[],
): Promise<void> {
  const dir = join(basePath, entry);
  let dirStat;
  try {
    dirStat = await stat(dir);
  } catch {
    return;
  }
  if (!dirStat.isDirectory()) return;

  const ws = await readWorkspace(join(dir, "workspace.yaml"));
  if (!ws) return;

  const sessionStart = new Date(ws.created_at ?? "");
  const segments = await readShutdownSegments(join(dir, "events.jsonl"));

  const sessionId = ws.id ?? entry;
  for (const segment of segments) {
    // Each segment is timestamped by its shutdown; fall back to the session
    // start if the line lacks a usable timestamp.
    const segDate = new Date(segment.timestamp ?? "");
    const occurredAt = Number.isNaN(segDate.getTime()) ? sessionStart : segDate;
    if (Number.isNaN(occurredAt.getTime())) continue;
    if (since && occurredAt <= since) continue;

    for (const [model, m] of Object.entries(segment.modelMetrics)) {
      const usage = isObject(m) && isObject(m.usage) ? m.usage : null;
      if (!usage) continue;
      events.push({
        externalId: `${sessionId}:${model}:${occurredAt.toISOString()}`,
        provider: "openai", // advisory only; server re-derives from model
        model,
        inputTokens: numOr0(usage.inputTokens),
        outputTokens: numOr0(usage.outputTokens),
        cacheReadTokens: numOr0(usage.cacheReadTokens),
        cacheCreationTokens: numOr0(usage.cacheWriteTokens),
        cacheWriteTokens: numOr0(usage.cacheWriteTokens),
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
        occurredAt,
        metadata: {
          cwd: ws.cwd,
          gitBranch: ws.branch,
          sessionId,
        },
      });
    }
  }
}

type Workspace ={ id?: string; cwd?: string; branch?: string; created_at?: string };

// workspace.yaml is flat `key: value` (no nesting in the keys we read).
async function readWorkspace(path: string): Promise<Workspace | null> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return null;
  }
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

type ShutdownSegment = { timestamp?: string; modelMetrics: Record<string, unknown> };

// Collect EVERY session.shutdown line (each is one segment of the session),
// in file order. An in-progress session with no shutdown yet yields [].
async function readShutdownSegments(path: string): Promise<ShutdownSegment[]> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return [];
  }
  const segments: ShutdownSegment[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      isObject(raw) &&
      raw.type === "session.shutdown" &&
      isObject(raw.data) &&
      isObject(raw.data.modelMetrics)
    ) {
      segments.push({
        timestamp: typeof raw.timestamp === "string" ? raw.timestamp : undefined,
        modelMetrics: raw.data.modelMetrics as Record<string, unknown>,
      });
    }
  }
  return segments;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function numOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
