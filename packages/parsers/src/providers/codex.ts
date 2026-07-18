import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import type { ParsedUsageEvent } from "./claude-code.js";

// Codex stores one JSONL rollout per session under
// $CODEX_HOME/sessions/YYYY/MM/DD (default: ~/.codex/sessions). We only read
// session metadata, turn context, and token-count records. Prompts, responses,
// reasoning, and tool payloads are never copied into the returned events.
//
// token_count.info.total_token_usage is cumulative for the session. The
// last_token_usage block is the exact increment for one model call, so every
// usable token_count line becomes one independently deduplicated event.

export function codexHomeDir(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured || join(homedir(), ".codex");
}

export function codexSessionsDir(): string {
  return join(codexHomeDir(), "sessions");
}

export async function scanCodexLogs(opts: {
  basePath?: string;
  since?: Date;
}): Promise<ParsedUsageEvent[]> {
  const basePath = opts.basePath ?? codexSessionsDir();
  const files = await findJsonlFiles(basePath);
  const host = hostname();
  const plat = platform();
  const events: ParsedUsageEvent[] = [];

  for (const path of files) {
    if (opts.since) {
      try {
        if ((await stat(path)).mtime < opts.since) continue;
      } catch {
        continue;
      }
    }
    events.push(...(await parseSession(path, opts.since, host, plat)));
  }

  return events;
}

async function findJsonlFiles(basePath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(basePath, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(basePath, entry.name);
    if (entry.isDirectory()) files.push(...(await findJsonlFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

type SessionContext = {
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  turnId?: string;
  client?: string;
  clientVersion?: string;
};

async function parseSession(
  path: string,
  since: Date | undefined,
  host: string,
  plat: string,
): Promise<ParsedUsageEvent[]> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return [];
  }

  const context: SessionContext = {};
  const events: ParsedUsageEvent[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(raw) || !isObject(raw.payload)) continue;

    if (raw.type === "session_meta") {
      readSessionMeta(raw.payload, context);
      continue;
    }
    if (raw.type === "turn_context") {
      readTurnContext(raw.payload, context);
      continue;
    }
    if (raw.type !== "event_msg" || raw.payload.type !== "token_count") continue;

    const event = parseTokenCount(raw, context, host, plat);
    if (event && (!since || event.occurredAt > since)) events.push(event);
  }

  return events;
}

function readSessionMeta(payload: Record<string, unknown>, context: SessionContext): void {
  context.sessionId = stringOr(payload.session_id) ?? stringOr(payload.id);
  context.cwd = stringOr(payload.cwd);
  context.client = stringOr(payload.originator) ?? stringOr(payload.source);
  context.clientVersion = stringOr(payload.cli_version);
  if (isObject(payload.git)) context.gitBranch = stringOr(payload.git.branch);
}

function readTurnContext(payload: Record<string, unknown>, context: SessionContext): void {
  context.turnId = stringOr(payload.turn_id);
  context.model = stringOr(payload.model);
  context.cwd = stringOr(payload.cwd) ?? context.cwd;
}

function parseTokenCount(
  raw: Record<string, unknown>,
  context: SessionContext,
  host: string,
  plat: string,
): ParsedUsageEvent | null {
  const timestamp = stringOr(raw.timestamp);
  if (!timestamp || !context.sessionId || !context.model) return null;
  const occurredAt = new Date(timestamp);
  if (Number.isNaN(occurredAt.getTime())) return null;

  const payload = raw.payload;
  if (!isObject(payload) || !isObject(payload.info)) return null;
  const usage = payload.info.last_token_usage;
  if (!isObject(usage)) return null;

  // OpenAI reports cached reads and cache writes as subsets of input_tokens.
  // Centrail prices these buckets separately, so ordinary input must exclude
  // both. Codex writes use the provider-neutral cache-write bucket; the
  // Anthropic duration-specific buckets remain zero.
  const totalInput = numOr0(usage.input_tokens);
  const cacheRead = numOr0(usage.cached_input_tokens);
  const cacheWrite = numOr0(usage.cache_write_input_tokens);
  const input = Math.max(0, totalInput - cacheRead - cacheWrite);
  const turn = context.turnId ?? "turn-unknown";

  return {
    externalId: `${context.sessionId}:${turn}:${occurredAt.toISOString()}`,
    provider: "openai",
    model: context.model,
    inputTokens: input,
    outputTokens: numOr0(usage.output_tokens),
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
    cacheWriteTokens: cacheWrite,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    occurredAt,
    metadata: {
      cwd: context.cwd,
      gitBranch: context.gitBranch,
      sessionId: context.sessionId,
      version: context.clientVersion,
      entrypoint: context.client,
      origin: {
        host,
        platform: plat,
        client: context.client ?? "codex",
        clientVersion: context.clientVersion,
      },
    },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function numOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}
function stringOr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
