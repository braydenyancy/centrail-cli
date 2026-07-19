import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { join, relative } from "node:path";
import type { ParsedUsageEvent } from "./claude-code.js";
import { suffixDuplicateExternalIds } from "./external-id.js";

// Codex stores one JSONL rollout per session under
// $CODEX_HOME/sessions/YYYY/MM/DD (default: ~/.codex/sessions). We only read
// session metadata, turn context, and token-count records. Prompts, responses,
// reasoning, and tool payloads are never copied into the returned events.
//
// token_count.info.total_token_usage is cumulative for the session. The
// last_token_usage block is the exact increment for one model call, so every
// usable token_count line becomes one independently deduplicated event.

export function codexHomeDir(): string {
  return codexHomeDirs()[0];
}

export function codexHomeDirs(): string[] {
  const configured = process.env.CODEX_HOME;
  if (!configured) return [join(homedir(), ".codex")];
  const dirs = configured
    .split(",")
    .map((dir) => dir.trim())
    .filter(Boolean);
  return dirs.length > 0 ? dirs : [join(homedir(), ".codex")];
}

export function codexSessionsDir(): string {
  return join(codexHomeDir(), "sessions");
}

export async function scanCodexLogs(opts: {
  basePath?: string;
  since?: Date;
}): Promise<ParsedUsageEvent[]> {
  const files = opts.basePath
    ? await findJsonlFiles(opts.basePath)
    : await findCodexUsageFiles();
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

  return suffixDuplicateExternalIds(events);
}

async function findCodexUsageFiles(): Promise<string[]> {
  const files: string[] = [];

  for (const home of codexHomeDirs()) {
    const roots = [join(home, "sessions"), join(home, "archived_sessions")];
    const seenRelativePaths = new Set<string>();
    let foundStandardRoot = false;

    for (const root of roots) {
      if (!(await isDirectory(root))) continue;
      foundStandardRoot = true;
      for (const path of await findJsonlFiles(root)) {
        const key = relative(root, path);
        if (seenRelativePaths.has(key)) continue;
        seenRelativePaths.add(key);
        files.push(path);
      }
    }

    // A custom CODEX_HOME may point directly at saved `codex exec --json`
    // output. Session-shaped JSONL within it is still safe to inspect.
    if (!foundStandardRoot) files.push(...(await findJsonlFiles(home)));
  }

  return files;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
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
  let previousTotals: TokenUsage | null = null;
  // The cumulative fallback is only safe while previousTotals accounts for
  // everything already emitted. A per-call line WITHOUT totals breaks that
  // invariant until the next line that carries totals restores it.
  let baselineValid = true;

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

    const parsed = parseTokenCount(raw, context, previousTotals, baselineValid, host, plat);
    if (parsed.total) {
      previousTotals = parsed.total;
      baselineValid = true; // session totals cover all usage emitted so far
    } else if (parsed.bareLast) {
      baselineValid = false;
    }
    const event = parsed.event;
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
  previousTotals: TokenUsage | null,
  baselineValid: boolean,
  host: string,
  plat: string,
): { event: ParsedUsageEvent | null; total: TokenUsage | null; bareLast: boolean } {
  const timestamp = stringOr(raw.timestamp);
  if (!timestamp || !context.sessionId) return { event: null, total: null, bareLast: false };
  const occurredAt = new Date(timestamp);
  if (Number.isNaN(occurredAt.getTime())) return { event: null, total: null, bareLast: false };

  const payload = raw.payload;
  if (!isObject(payload) || !isObject(payload.info)) {
    return { event: null, total: null, bareLast: false };
  }
  const info = payload.info;
  const total = readTokenUsage(info.total_token_usage);
  const last = readTokenUsage(info.last_token_usage);
  // Fall back to cumulative deltas only while the baseline is trustworthy;
  // otherwise the delta would re-emit usage already counted from per-call
  // lines, so the line is absorbed as the new baseline instead.
  const usage =
    last ?? (total && baselineValid ? subtractTokenUsage(total, previousTotals) : null);
  const bareLast = last !== null && total === null;
  const model = stringOr(payload.model) ?? stringOr(info.model) ?? context.model;
  if (!usage || !model) return { event: null, total, bareLast };

  // OpenAI reports cached reads and cache writes as subsets of input_tokens.
  // Centrail prices these buckets separately, so ordinary input must exclude
  // both. Codex writes use the provider-neutral cache-write bucket; the
  // Anthropic duration-specific buckets remain zero.
  const totalInput = usage.inputTokens;
  const cacheRead = usage.cachedInputTokens;
  const cacheWrite = usage.cacheWriteInputTokens;
  const input = Math.max(0, totalInput - cacheRead - cacheWrite);
  const turn = context.turnId ?? "turn-unknown";

  return {
    event: {
      externalId: `${context.sessionId}:${turn}:${occurredAt.toISOString()}`,
      provider: "openai",
      model,
      inputTokens: input,
      outputTokens: usage.outputTokens,
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
    },
    total,
    bareLast,
  };
}

type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
};

function readTokenUsage(raw: unknown): TokenUsage | null {
  if (!isObject(raw)) return null;
  return {
    inputTokens: numOr0(raw.input_tokens),
    cachedInputTokens: numOr0(raw.cached_input_tokens),
    cacheWriteInputTokens: numOr0(raw.cache_write_input_tokens),
    outputTokens: numOr0(raw.output_tokens),
  };
}

function subtractTokenUsage(
  current: TokenUsage,
  previous: TokenUsage | null,
): TokenUsage {
  return {
    inputTokens: Math.max(0, current.inputTokens - (previous?.inputTokens ?? 0)),
    cachedInputTokens: Math.max(
      0,
      current.cachedInputTokens - (previous?.cachedInputTokens ?? 0),
    ),
    cacheWriteInputTokens: Math.max(
      0,
      current.cacheWriteInputTokens - (previous?.cacheWriteInputTokens ?? 0),
    ),
    outputTokens: Math.max(0, current.outputTokens - (previous?.outputTokens ?? 0)),
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
