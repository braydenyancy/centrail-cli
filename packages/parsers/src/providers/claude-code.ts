import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { claudeToolEvidence, mergeEvidence, type Evidence } from "./evidence.js";

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

// One identity per repo, the same for every checkout of it. `key` is what
// rules and grouping bind to; `label` is what a human sees. Computed by the
// CLI (which has git); the parsers only carry it. See identity.ts in the CLI.
export type RepoIdentity = {
  key: string; // "github.com/owner/repo" | "sha:<root commit>" | "dir:<hmac>"
  label: string; // folder basename, display only
  source: "remote" | "root" | "folder";
};

// How a request's repo was chosen (§ 3.9): its session's cwd is inside the
// repo; its turn's touched files name it; the session's previous turn
// did; or nothing did and it is the folder's own id. Shipped as the
// disclaimer next to `repo`.
export type Placement = "cwd" | "files" | "sticky" | "folder";

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
    cwd?: string; // dropped from the wire once the server accepts `repo`
    gitBranch?: string;
    sessionId?: string;
    version?: string;
    entrypoint?: string;
    isSidechain?: boolean;
    repo?: RepoIdentity; // set by the CLI at sync time; absent = unresolved
    placement?: Placement; // how `repo` was chosen; set with it
    turn?: string; // local only: the transcript turn this request belongs to
    touched?: Evidence; // local only: files this request wrote and read
    fallback?: boolean; // local only: this line carries the fallback iteration; see collapse
    messageId?: string; // local only: for sidechain-replay folding
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
  return [
    join(homedir(), ".claude"),
    join(homedir(), ".config", "claude"),
    // Xcode's Claude agent keeps its own config (phuryn/claude-usage scanner.py:21).
    join(homedir(), "Library", "Developer", "Xcode", "CodingAssistant", "ClaudeAgentConfig"),
  ];
}

// An entry may name the config dir (…/.claude) or its projects dir itself
// (ccusage accepts both, paths.rs); the latter is scanned as it is.
export function claudeProjectDirs(): string[] {
  return claudeConfigDirs().map((d) => (basename(d.replace(/[\\/]+$/, "")) === "projects" ? d : join(d, "projects")));
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
    // Never `push(...big)`: a year of transcripts is more arguments than a
    // call takes, and the spread crashed a full scan at 177k lines.
    for (const e of await scanProjectsDir(base, since)) events.push(e);
  }
  return collapseUsageEvents(foldSidechainReplays(events));
}

// A /btw side question runs in a sidechain that replays parent messages
// under a NEW requestId (ccusage rust/adapters/claude/src/lib.rs:238). A
// sidechain event whose message id and session match a non-sidechain one
// is that response, not another. Only when a sidechain is on one side: a
// gateway that reuses one message id across real responses stays apart.
export function foldSidechainReplays(events: ParsedUsageEvent[]): ParsedUsageEvent[] {
  const parentId = new Map<string, string>();
  for (const e of events) {
    const m = e.metadata;
    if (m.isSidechain === true || !m.messageId) continue;
    const k = `${m.sessionId ?? ""}\u0000${m.messageId}`;
    if (!parentId.has(k)) parentId.set(k, e.externalId);
  }
  for (const e of events) {
    const m = e.metadata;
    if (m.isSidechain !== true || !m.messageId) continue;
    const id = parentId.get(`${m.sessionId ?? ""}\u0000${m.messageId}`);
    if (id && !/:(iter|advisor):\d+$/.test(e.externalId)) e.externalId = id;
  }
  return events;
}

// Claude Code writes one transcript line per content block of a response
// (thinking, tool_use, text), every line stamped with that response's
// usage — and `output_tokens` GROWS across them, because each line carries
// the count streamed so far. Measured on 79,014 requests: 25,827 had lines
// that disagree, always and only on output_tokens, and keeping the first
// line undercounted output by 36.7%. Input and cache counts never differ.
// So one request collapses to one event holding the per-field maximum:
// order-independent, and equal to the final line whenever the file is
// complete. (ccusage keeps the larger total for the same reason —
// rust/adapters/claude/src/lib.rs, should_replace_deduped_entry.)
export function collapseUsageEvents(events: ParsedUsageEvent[]): ParsedUsageEvent[] {
  const byId = new Map<string, ParsedUsageEvent>();
  for (const e of events) {
    const prev = byId.get(e.externalId);
    if (!prev) {
      byId.set(e.externalId, e);
      continue;
    }
    // A sidechain replay of a response is that response again, never more
    // of it: the non-sidechain original wins whole, whatever the replay's
    // counts (ccusage's posture; from the 0.5.1 hotfix). Only when exactly
    // one side is a sidechain — two lines of one stream take the max below.
    const prevSide = prev.metadata.isSidechain === true;
    const nextSide = e.metadata.isSidechain === true;
    if (prevSide !== nextSide) {
      if (prevSide) byId.set(e.externalId, e);
      continue;
    }
    // A response that fell back to another model: its streamed lines carry
    // the FIRST attempt's counts (counted as `<id>:iter:<i>`), so the line
    // with the fallback iteration replaces them rather than taking a max.
    if (e.metadata.fallback && !prev.metadata.fallback) {
      const at = prev.occurredAt < e.occurredAt ? prev.occurredAt : e.occurredAt;
      const touched = mergeEvidence(prev.metadata.touched, e.metadata.touched);
      const turn = prev.metadata.turn ?? e.metadata.turn;
      Object.assign(prev, { ...e, occurredAt: at, metadata: { ...e.metadata, touched, turn } });
      continue;
    }
    if (prev.metadata.fallback && !e.metadata.fallback) {
      prev.metadata.touched = mergeEvidence(prev.metadata.touched, e.metadata.touched);
      if (e.occurredAt < prev.occurredAt) prev.occurredAt = e.occurredAt;
      continue;
    }
    prev.inputTokens = Math.max(prev.inputTokens, e.inputTokens);
    prev.outputTokens = Math.max(prev.outputTokens, e.outputTokens);
    prev.cacheReadTokens = Math.max(prev.cacheReadTokens, e.cacheReadTokens);
    prev.cacheCreationTokens = Math.max(prev.cacheCreationTokens, e.cacheCreationTokens);
    prev.cacheCreation5mTokens = Math.max(prev.cacheCreation5mTokens, e.cacheCreation5mTokens);
    prev.cacheCreation1hTokens = Math.max(prev.cacheCreation1hTokens, e.cacheCreation1hTokens);
    if (e.cacheWriteTokens !== undefined) {
      prev.cacheWriteTokens = Math.max(prev.cacheWriteTokens ?? 0, e.cacheWriteTokens);
    }
    if (e.metadata.touched) prev.metadata.touched = mergeEvidence(prev.metadata.touched, e.metadata.touched);
    if (!prev.metadata.turn) prev.metadata.turn = e.metadata.turn;
    // The earliest timestamp is the request's start; keep it.
    if (e.occurredAt < prev.occurredAt) prev.occurredAt = e.occurredAt;
  }
  return [...byId.values()];
}

// One id per API response. Anthropic's `requestId` is it when present. Some
// gateways (Bedrock, Vertex, proxies) omit it; then the message id, scoped
// to the session, is the key. NOT the timestamp: every content block of one
// response is written as its own line with its own timestamp (99.3% of
// multi-line requests on a 79,014-request corpus), so a key that included
// it would count one response once per block, at the streamed-so-far
// value. A gateway that reused one message id for two responses in one
// session would fold them; no corpus has shown one, and the split is the
// measured loss. Both shapes are stable across rescans of the same
// transcript, which is what the server's unique index needs.
function usageExternalId(raw: Record<string, unknown>, message: Record<string, unknown>): string | null {
  if (typeof raw.requestId === "string" && raw.requestId.length > 0) return raw.requestId;
  const messageId = message.id;
  if (typeof messageId !== "string" || messageId.length === 0) return null;
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
  return `msg:${messageId}:${sessionId}`;
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
      // Turns are numbered per file: a subagent transcript restarts at 1
      // and must not share turn ids with its parent.
      const turns = new TurnCounter(basename(path, ".jsonl"));
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        turns.observe(raw);
        const parsed = parseAssistantEvent(raw, turns.current);
        if (parsed && (!since || parsed.occurredAt > since)) {
          applyFallback(raw, parsed);
          events.push(parsed);
          for (const extra of extraIterations(raw, parsed)) events.push(extra);
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

// A turn starts at a human prompt: a `user` line whose content is a string
// or a block list with no tool_result, and that is not meta. Everything up
// to the next one — tool results, every assistant response — is one turn,
// and § 3.9's measurement is that a turn never names two repos.
export class TurnCounter {
  private n = 0;
  constructor(private readonly scope: string) {}
  get current(): string {
    return `${this.scope}#${this.n}`;
  }
  observe(raw: unknown): void {
    if (!isObject(raw) || raw.type !== "user" || raw.isMeta === true) return;
    const message = raw.message;
    if (!isObject(message)) return;
    const content = message.content;
    if (typeof content === "string") this.n++;
    else if (Array.isArray(content) && !content.some((b) => isObject(b) && b.type === "tool_result")) this.n++;
  }
}

// The files one assistant line's tool_use block names (one block per line).
export function lineEvidence(message: Record<string, unknown>): Evidence {
  let out: Evidence = { writes: [], reads: [] };
  if (!Array.isArray(message.content)) return out;
  for (const block of message.content) {
    if (isObject(block) && block.type === "tool_use") out = mergeEvidence(out, claudeToolEvidence({ name: block.name, input: block.input }));
  }
  return out;
}

// `usage.iterations` splits one response into billed calls. Two kinds are
// NOT in the top-level usage and are counted as their own events:
//   - `message` iterations before a `fallback_message`: the first attempt(s)
//     on the original model, before the response fell back (measured: 6
//     requests, 1.32M cache-read tokens on the pricier model; no other tool
//     counts them). `<id>:iter:<i>`.
//   - `advisor_message` iterations, in any position (ccusage's rule,
//     rust/adapters/claude/src/lib.rs advisor_usages_from_line). `<id>:advisor:<i>`.
// Executor `message` iterations without a fallback ARE the top-level usage,
// model or not, and add nothing.
function extraIterations(raw: unknown, top: ParsedUsageEvent): ParsedUsageEvent[] {
  const iterations = iterationsOf(raw);
  if (iterations.length < 2) return [];
  const firstFallback = iterations.findIndex((it) => it.type === "fallback_message");
  const out: ParsedUsageEvent[] = [];
  iterations.forEach((it, i) => {
    const firstAttempt = firstFallback > 0 && i < firstFallback && it.type === "message";
    const advisor = it.type === "advisor_message";
    if (!firstAttempt && !advisor) return;
    if (typeof it.model !== "string" || !it.model || it.model === "<synthetic>") return;
    out.push({
      ...top,
      ...usageFields(it),
      externalId: `${top.externalId}:${advisor ? "advisor" : "iter"}:${i}`,
      model: it.model,
      metadata: { ...top.metadata, touched: { writes: [], reads: [] }, fallback: undefined },
    });
  });
  return out;
}

function iterationsOf(raw: unknown): Record<string, unknown>[] {
  if (!isObject(raw) || !isObject(raw.message) || !isObject(raw.message.usage)) return [];
  const it = raw.message.usage.iterations;
  return Array.isArray(it) ? it.filter(isObject) : [];
}

function usageFields(u: Record<string, unknown>) {
  const cc = isObject(u.cache_creation) ? u.cache_creation : null;
  return {
    inputTokens: numOr0(u.input_tokens),
    outputTokens: numOr0(u.output_tokens),
    cacheReadTokens: numOr0(u.cache_read_input_tokens),
    cacheCreationTokens: numOr0(u.cache_creation_input_tokens),
    cacheCreation5mTokens: cc ? numOr0(cc.ephemeral_5m_input_tokens) : 0,
    cacheCreation1hTokens: cc ? numOr0(cc.ephemeral_1h_input_tokens) : 0,
  };
}

// On the line that carries a fallback, the response IS the fallback
// iteration: its counts, its model, and its own cache split (the top-level
// split on that line is still the first attempt's — measured).
function applyFallback(raw: unknown, e: ParsedUsageEvent): void {
  const iterations = iterationsOf(raw);
  const fb = [...iterations].reverse().find((it) => it.type === "fallback_message");
  if (!fb) return;
  Object.assign(e, usageFields(fb));
  if (typeof fb.model === "string" && fb.model) e.model = fb.model;
  e.metadata.fallback = true;
}

function parseAssistantEvent(raw: unknown, turn?: string): ParsedUsageEvent | null {
  if (!isObject(raw)) return null;
  if (raw.type !== "assistant") return null;

  const message = raw.message;
  if (!isObject(message)) return null;
  const usage = message.usage;
  if (!isObject(usage)) return null;

  const model = message.model;
  const timestamp = raw.timestamp;
  if (typeof model !== "string") return null;
  if (typeof timestamp !== "string") return null;
  const externalId = usageExternalId(raw, message);
  if (!externalId) return null;
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
    externalId,
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
      turn,
      touched: lineEvidence(message),
      messageId: stringOr(message.id),
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
function boolOr(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
