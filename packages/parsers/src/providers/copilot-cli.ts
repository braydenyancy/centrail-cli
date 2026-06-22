import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedUsageEvent } from "./claude-code.js";

// Scans GitHub Copilot CLI session logs. Each session lives in
// ~/.copilot/session-state/<uuid>/ with a flat `workspace.yaml` and an
// `events.jsonl`. The authoritative usage totals are the single
// `session.shutdown` line's `data.modelMetrics`, keyed by model. We emit one
// event per (session, model). provider is left for the server to derive from
// the model; we set a best-effort value here for any local display.
//
// Pure local-filesystem code — no framework imports.

const DEFAULT_BASE_PATH = join(homedir(), ".copilot", "session-state");

export async function scanCopilotLogs(opts: {
  basePath?: string;
  since?: Date;
}): Promise<ParsedUsageEvent[]> {
  const basePath = opts.basePath ?? DEFAULT_BASE_PATH;
  const since = opts.since;

  let entries: string[];
  try {
    entries = await readdir(basePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const events: ParsedUsageEvent[] = [];

  for (const entry of entries) {
    const dir = join(basePath, entry);
    let dirStat;
    try {
      dirStat = await stat(dir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;

    const ws = await readWorkspace(join(dir, "workspace.yaml"));
    if (!ws) continue;

    const occurredAt = new Date(ws.created_at ?? "");
    if (Number.isNaN(occurredAt.getTime())) continue;
    if (since && occurredAt <= since) continue;

    const metrics = await readShutdownMetrics(join(dir, "events.jsonl"));
    if (!metrics) continue; // in-progress or no usage yet

    const sessionId = ws.id ?? entry;
    for (const [model, m] of Object.entries(metrics)) {
      const usage = isObject(m) && isObject(m.usage) ? m.usage : null;
      if (!usage) continue;
      events.push({
        externalId: `${sessionId}:${model}`,
        provider: "openai", // advisory only; server re-derives from model
        model,
        inputTokens: numOr0(usage.inputTokens),
        outputTokens: numOr0(usage.outputTokens),
        cacheReadTokens: numOr0(usage.cacheReadTokens),
        cacheCreationTokens: numOr0(usage.cacheWriteTokens),
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
        occurredAt,
        metadata: {
          cwd: ws.cwd,
          gitBranch: ws.branch,
          sessionId,
          origin: { host: "", platform: "", client: "copilot-cli" },
        },
      });
    }
  }

  return events;
}

type Workspace = { id?: string; cwd?: string; branch?: string; created_at?: string };

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

// Find the last session.shutdown line and return its modelMetrics, or null.
async function readShutdownMetrics(
  path: string,
): Promise<Record<string, unknown> | null> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return null;
  }
  let metrics: Record<string, unknown> | null = null;
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
      metrics = raw.data.modelMetrics as Record<string, unknown>;
    }
  }
  return metrics;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function numOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
