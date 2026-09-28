import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Scans Claude Code's local JSONL logs and returns parsed usage events.
//
// Each session is a JSONL file under ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl.
// We only care about `type: "assistant"` lines — those carry the model + usage
// breakdown. Other types (user, queue-operation, file-history-snapshot, etc.)
// are skipped. `<synthetic>` model events (e.g. internal prompts) are also
// skipped — they don't represent real billing.
//
// This module is pure local-filesystem code shared by the Next.js app (local
// dev mode) and the centrail CLI (hosted mode) — keep it free of any
// framework or server-only imports.

export type ParsedUsageEvent = {
  externalId: string; // Anthropic request id, used for dedup
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number; // provider-reported cache writes
  cacheWriteTokens?: number; // provider-neutral cache writes; omitted by legacy clients
  cacheCreation5mTokens: number; // Anthropic ephemeral 5m
  cacheCreation1hTokens: number; // Anthropic 1h; 0 for providers without it
  occurredAt: Date;
  metadata: {
    cwd?: string;
    gitBranch?: string;
    sessionId?: string;
    version?: string;
    entrypoint?: string;
    isSidechain?: boolean;
    origin?: {
      host: string;
      platform: string;
      client?: string; // e.g. "claude-vscode" — from entrypoint
      clientVersion?: string; // Claude Code version
    };
  };
};

export type ClaudeCodeAccount = {
  accountUuid?: string;
  emailAddress?: string;
  organizationUuid?: string;
  billingType?: string;
};

// Claude Code stores session logs under <config-dir>/projects and its account
// under <config-dir>/.claude.json. The config dir defaults to ~/.claude, but can
// be relocated via CLAUDE_CONFIG_DIR (comma-separated for multi-account setups),
// and some installs use ~/.config/claude. We resolve every candidate and read
// each that exists — mirroring how Claude Code and ccusage locate the config.
export function claudeConfigDirs(): string[] {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && env.trim()) {
    return env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [join(homedir(), ".claude"), join(homedir(), ".config", "claude")];
}

export function claudeProjectDirs(): string[] {
  return claudeConfigDirs().map((d) => join(d, "projects"));
}

// Account-file candidates: <config-dir>/.claude.json when CLAUDE_CONFIG_DIR is
// set, plus the classic ~/.claude.json (a sibling of ~/.claude, not inside it).
function claudeAccountFiles(): string[] {
  const env = process.env.CLAUDE_CONFIG_DIR;
  const files: string[] = [];
  if (env && env.trim()) {
    for (const d of env.split(",").map((s) => s.trim()).filter(Boolean)) {
      files.push(join(d, ".claude.json"));
    }
  }
  files.push(join(homedir(), ".claude.json"));
  return files;
}

async function readAccountFile(filePath: string): Promise<ClaudeCodeAccount | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const json = JSON.parse(content) as Record<string, unknown>;
    const acct = json.oauthAccount;
    if (!isObject(acct)) return null;
    return {
      accountUuid: stringOr(acct.accountUuid),
      emailAddress: stringOr(acct.emailAddress),
      organizationUuid: stringOr(acct.organizationUuid),
      billingType: stringOr(acct.billingType),
    };
  } catch {
    return null;
  }
}

// Reads the currently-logged-in Claude Code account. With no argument, tries the
// resolved candidate files (CLAUDE_CONFIG_DIR-aware) and returns the first hit;
// pass an explicit path to read just that file. Returns null if none have an
// oauthAccount block (e.g. Claude Code was never signed in here).
export async function readClaudeCodeAccount(
  filePath?: string,
): Promise<ClaudeCodeAccount | null> {
  const candidates = filePath ? [filePath] : claudeAccountFiles();
  for (const p of candidates) {
    const acct = await readAccountFile(p);
    if (acct) return acct;
  }
  return null;
}

// Scans Claude Code logs across all resolved config dirs (or a single
// `basePath` when provided for tests), then collapses streaming snapshots and
// copied transcripts before returning events to the caller.
export async function scanClaudeCodeLogs(opts: {
  basePath?: string;
  since?: Date;
}): Promise<ParsedUsageEvent[]> {
  const since = opts.since;
  const bases = opts.basePath ? [opts.basePath] : claudeProjectDirs();

  const events: ParsedUsageEvent[] = [];
  for (const base of bases) {
    events.push(...(await scanProjectsDir(base, since)));
  }
  return dedupeClaudeSnapshots(events);
}

// Scans one <config-dir>/projects directory. Missing dir → no events.
async function scanProjectsDir(
  basePath: string,
  since: Date | undefined,
): Promise<ParsedUsageEvent[]> {
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

    for (const path of await listSessionFiles(dir)) {
      // A transcript can be rotated or swept between listing and reading —
      // Claude Code's retention sweep does exactly that. Skip it; one vanished
      // file must never abort the whole scan.
      let fileStat;
      try {
        fileStat = await stat(path);
      } catch {
        continue;
      }
      // Skip files unchanged since last sync. Conservative cut: we use mtime,
      // so a long-running session keeps reprocessing until it closes —
      // dedup-by-externalId catches the duplicates downstream.
      if (since && fileStat.mtime < since) continue;

      let content: string;
      try {
        content = await readFile(path, "utf-8");
      } catch {
        continue;
      }
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        const parsed = parseAssistantEvent(raw);
        if (parsed && (!since || parsed.occurredAt > since)) {
          events.push(parsed);
        }
      }
    }
  }

  return events;
}

// Transcripts for one project dir: top-level <session>.jsonl files plus JSONL
// anywhere below each session's known subagents/ root. Claude Code currently
// writes both subagents/<agent>.jsonl and
// subagents/workflows/<workflow>/<agent>.jsonl. Traversal is bounded and does
// not follow symlinks, so unrelated project files remain out of scope.
async function listSessionFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      if (entry.name.endsWith(".jsonl")) files.push(join(dir, entry.name));
      continue;
    }
    if (!entry.isDirectory()) continue;
    const sub = join(dir, entry.name, "subagents");
    files.push(...(await listJsonlBelow(sub, 8)));
  }
  return files;
}

async function listJsonlBelow(dir: string, remainingDepth: number): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    } else if (entry.isDirectory() && remainingDepth > 0) {
      files.push(...(await listJsonlBelow(path, remainingDepth - 1)));
    }
  }
  return files;
}

function parseAssistantEvent(raw: unknown): ParsedUsageEvent | null {
  if (!isObject(raw)) return null;
  if (raw.type !== "assistant") return null;

  const message = raw.message;
  if (!isObject(message)) return null;
  const usage = message.usage;
  if (!isObject(usage)) return null;

  const requestId = raw.requestId;
  const model = message.model;
  const timestamp = raw.timestamp;
  if (typeof requestId !== "string") return null;
  if (typeof model !== "string") return null;
  if (typeof timestamp !== "string") return null;
  // Skip synthetic events — internal Claude Code prompts that don't bill.
  if (model === "<synthetic>") return null;

  const occurredAt = new Date(timestamp);
  if (Number.isNaN(occurredAt.getTime())) return null;

  // Split cache creation by retention. The bundled `cache_creation_input_tokens`
  // is the total; the `cache_creation` object has the per-rate breakdown.
  const cacheCreationTotal = numOr0(usage.cache_creation_input_tokens);
  const cc = isObject(usage.cache_creation) ? usage.cache_creation : null;
  const cache5m = cc ? numOr0(cc.ephemeral_5m_input_tokens) : 0;
  const cache1h = cc ? numOr0(cc.ephemeral_1h_input_tokens) : 0;

  const entrypoint = stringOr(raw.entrypoint);
  const version = stringOr(raw.version);

  return {
    externalId: requestId,
    provider: "anthropic",
    model,
    inputTokens: numOr0(usage.input_tokens),
    outputTokens: numOr0(usage.output_tokens),
    cacheReadTokens: numOr0(usage.cache_read_input_tokens),
    cacheCreationTokens: cacheCreationTotal,
    cacheCreation5mTokens: cache5m,
    cacheCreation1hTokens: cache1h,
    occurredAt,
    metadata: {
      cwd: stringOr(raw.cwd),
      gitBranch: stringOr(raw.gitBranch),
      sessionId: stringOr(raw.sessionId),
      version,
      entrypoint,
      isSidechain: boolOr(raw.isSidechain),
    },
  };
}

// Claude can append several snapshots for one response while it streams. They
// share a requestId but later snapshots usually contain more complete usage.
// Sending all of them would make the server keep an arbitrary first record;
// summing them would overcount. Match ccusage's current posture: prefer the
// non-sidechain original over a replay, then keep the largest usage snapshot.
function dedupeClaudeSnapshots(events: ParsedUsageEvent[]): ParsedUsageEvent[] {
  const deduped = new Map<string, ParsedUsageEvent>();
  for (const candidate of events) {
    const existing = deduped.get(candidate.externalId);
    if (!existing || shouldReplaceSnapshot(candidate, existing)) {
      deduped.set(candidate.externalId, candidate);
    }
  }
  return [...deduped.values()];
}

function shouldReplaceSnapshot(
  candidate: ParsedUsageEvent,
  existing: ParsedUsageEvent,
): boolean {
  const candidateSidechain = candidate.metadata.isSidechain === true;
  const existingSidechain = existing.metadata.isSidechain === true;
  if (candidateSidechain !== existingSidechain) return existingSidechain;

  const candidateTotal = totalTokens(candidate);
  const existingTotal = totalTokens(existing);
  if (candidateTotal !== existingTotal) return candidateTotal > existingTotal;
  return candidate.occurredAt > existing.occurredAt;
}

function totalTokens(event: ParsedUsageEvent): number {
  return (
    event.inputTokens +
    event.outputTokens +
    event.cacheReadTokens +
    event.cacheCreationTokens
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function numOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function stringOr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function boolOr(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
