import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
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
  cacheCreationTokens: number; // total = 5m + 1h
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  occurredAt: Date;
  metadata: {
    cwd?: string;
    gitBranch?: string;
    sessionId?: string;
    version?: string;
    entrypoint?: string;
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

const DEFAULT_BASE_PATH = join(homedir(), ".claude", "projects");
const ACCOUNT_FILE = join(homedir(), ".claude.json");

// Reads the currently-logged-in Claude Code account from ~/.claude.json.
// Returns null if the file doesn't exist, can't be parsed, or has no
// oauthAccount block (e.g. Claude Code was never signed in here).
export async function readClaudeCodeAccount(
  filePath: string = ACCOUNT_FILE,
): Promise<ClaudeCodeAccount | null> {
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

export async function scanClaudeCodeLogs(opts: {
  basePath?: string;
  since?: Date;
}): Promise<ParsedUsageEvent[]> {
  const basePath = opts.basePath ?? DEFAULT_BASE_PATH;
  const since = opts.since;
  const host = hostname();
  const plat = platform();

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

    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(dir, file);
      const fileStat = await stat(path);
      // Skip files unchanged since last sync. Conservative cut: we use mtime,
      // so a long-running session keeps reprocessing until it closes —
      // dedup-by-externalId catches the duplicates downstream.
      if (since && fileStat.mtime < since) continue;

      const content = await readFile(path, "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        const parsed = parseAssistantEvent(raw, host, plat);
        if (parsed && (!since || parsed.occurredAt > since)) {
          events.push(parsed);
        }
      }
    }
  }

  return events;
}

function parseAssistantEvent(
  raw: unknown,
  host: string,
  plat: string,
): ParsedUsageEvent | null {
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
      origin: {
        host,
        platform: plat,
        client: entrypoint,
        clientVersion: version,
      },
    },
  };
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
