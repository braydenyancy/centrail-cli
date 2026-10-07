import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { ParsedUsageEvent } from "./claude-code.js";
import { suffixDuplicateExternalIds } from "./external-id.js";
import { codexCallEvidence, mergeEvidence, type Evidence } from "./evidence.js";

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
  wholeFiles?: boolean;
  onFile?: (done: number, total: number) => void;
}): Promise<ParsedUsageEvent[]> {
  const files = opts.basePath
    ? await findJsonlFiles(opts.basePath)
    : await findCodexUsageFiles();
  const events: ParsedUsageEvent[] = [];
  const metaByPath = new Map<string, ForkMeta>();
  for (const path of files) metaByPath.set(path, await readForkMeta(path));
  const pathBySession = new Map<string, string>();
  for (const [path, m] of metaByPath) if (m.sessionId && !pathBySession.has(m.sessionId)) pathBySession.set(m.sessionId, path);
  const parents = new Map<string, ParsedUsageEvent[]>();

  const toRead: string[] = [];
  for (const path of files) {
    if (opts.since) {
      try {
        if ((await stat(path)).mtime < opts.since) continue;
      } catch {
        continue;
      }
    }
    toRead.push(path);
  }

  for (let i = 0; i < toRead.length; i++) {
    const path = toRead[i];
    // Parse without `since`, drop a fork's replayed prefix, then filter:
    // the replay carries fresh timestamps, so `since` cannot catch it.
    let parsed = await parseSession(path, undefined);
    const fork = metaByPath.get(path);
    if (fork?.forkedFrom) parsed = await dropForkReplay(parsed, fork, pathBySession.get(fork.forkedFrom), parents);
    for (const e of parsed) {
      if (opts.since && e.occurredAt <= opts.since) {
        if (!opts.wholeFiles) continue;
        e.metadata.context = true; // its session's earlier turn: placed, not sent
      }
      events.push(e);
    }
    opts.onFile?.(i + 1, toRead.length);
  }

  return suffixDuplicateExternalIds(events);
}

// A forked Codex session (session_meta.forked_from_id) starts by replaying
// the parent's history into its own rollout with NEW timestamps — one user's
// day read $9.64 → $73.89 (ccusage #1337). The replay is the parent's usage
// recorded up to the fork, so that many leading events of the child are
// dropped. Without the parent's rollout, the leading burst — events less
// than a second apart — is the replay (ccusage's fallback, replay.rs).
type ForkMeta = { sessionId?: string; forkedFrom?: string; forkedAt?: Date };
const REPLAY_BURST_MS = 1000;

async function readForkMeta(path: string): Promise<ForkMeta> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return {};
  }
  for (const line of content.split("\n", 50)) {
    if (!line.includes('"session_meta"')) continue;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const p = isObject(raw.payload) ? raw.payload : {};
      const at = stringOr(p.timestamp) ?? stringOr(raw.timestamp);
      return {
        sessionId: stringOr(p.session_id) ?? stringOr(p.id),
        forkedFrom: stringOr(p.forked_from_id),
        forkedAt: at ? new Date(at) : undefined,
      };
    } catch {
      return {};
    }
  }
  return {};
}

async function dropForkReplay(
  child: ParsedUsageEvent[],
  fork: ForkMeta,
  parentPath: string | undefined,
  parents: Map<string, ParsedUsageEvent[]>,
): Promise<ParsedUsageEvent[]> {
  if (parentPath) {
    let parent = parents.get(parentPath);
    if (!parent) {
      parent = await parseSession(parentPath, undefined);
      parents.set(parentPath, parent);
    }
    const at = fork.forkedAt?.getTime();
    const replayed = at === undefined || Number.isNaN(at) ? parent.length : parent.filter((e) => e.occurredAt.getTime() <= at).length;
    return child.slice(replayed);
  }
  let burst = 0;
  while (burst + 1 < child.length && child[burst + 1].occurredAt.getTime() - child[burst].occurredAt.getTime() < REPLAY_BURST_MS) burst++;
  return burst > 0 ? child.slice(burst + 1) : child;
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
    if (!foundStandardRoot) for (const f of await findJsonlFiles(home)) files.push(f);
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
    if (entry.isDirectory()) for (const f of await findJsonlFiles(path)) files.push(f);
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
  touched?: Evidence; // this turn's function_call evidence so far
};

async function parseSession(
  path: string,
  since: Date | undefined,
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
    if (raw.type === "response_item" && raw.payload.type === "function_call") {
      context.touched = mergeEvidence(context.touched, codexCallEvidence(raw.payload.name, raw.payload.arguments, context.cwd ?? "/"));
      continue;
    }
    if (raw.type !== "event_msg" || raw.payload.type !== "token_count") continue;

    const parsed = parseTokenCount(raw, context, previousTotals, baselineValid);
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
  const turnId = stringOr(payload.turn_id);
  if (turnId !== context.turnId) context.touched = undefined; // a new turn starts its own evidence
  context.turnId = turnId;
  context.model = stringOr(payload.model);
  context.cwd = stringOr(payload.cwd) ?? context.cwd;
}

function parseTokenCount(
  raw: Record<string, unknown>,
  context: SessionContext,
  previousTotals: TokenUsage | null,
  baselineValid: boolean,
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
  // Codex re-emits token_count with UNCHANGED session totals on UI refresh
  // and rate-limit updates, each with a fresh timestamp and often the same
  // last_token_usage — counting them overstated one user's history by 67%
  // (ccusage #1288, #1434). Totals that did not advance are not usage.
  if (total && previousTotals && sameUsage(total, previousTotals)) {
    return { event: null, total, bareLast: false };
  }
  // Snapshots can arrive slightly out of order: the cumulative total steps
  // back by about one increment, then resumes. That row is stale, not a
  // reset — keep the higher baseline and count nothing (tokscale
  // crates/tokscale-core/src/sessions/codex.rs:222). A total that falls far
  // below is a real reset and counts from its own last usage.
  if (total && previousTotals && last && looksStale(total, previousTotals, last)) {
    return { event: null, total: previousTotals, bareLast: false };
  }
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
        turn: context.turnId ? `${context.sessionId}#${context.turnId}` : undefined,
        touched: context.touched ? { writes: [...context.touched.writes], reads: [...context.touched.reads] } : { writes: [], reads: [] },
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

function usageSum(u: TokenUsage): number {
  return u.inputTokens + u.outputTokens;
}

function looksStale(current: TokenUsage, previous: TokenUsage, last: TokenUsage): boolean {
  const cur = usageSum(current);
  const prev = usageSum(previous);
  if (cur >= prev || cur <= 0 || usageSum(last) <= 0) return false;
  return cur * 100 >= prev * 98 || cur + 2 * usageSum(last) >= prev;
}

function sameUsage(a: TokenUsage, b: TokenUsage): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.cachedInputTokens === b.cachedInputTokens &&
    a.cacheWriteInputTokens === b.cacheWriteInputTokens &&
    a.outputTokens === b.outputTokens
  );
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
