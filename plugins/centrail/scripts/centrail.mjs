#!/usr/bin/env node

// src/commands/connect.ts
import { readdir as readdir6 } from "node:fs/promises";

// ../parsers/src/providers/claude-code.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join as join2 } from "node:path";

// ../parsers/src/providers/evidence.ts
import { isAbsolute, join } from "node:path";
var NO_EVIDENCE = Object.freeze({ writes: [], reads: [] });
function mergeEvidence(a, b) {
  if (!a) return b ?? { writes: [], reads: [] };
  if (!b) return a;
  return { writes: union(a.writes, b.writes), reads: union(a.reads, b.reads) };
}
function union(x, y) {
  return [.../* @__PURE__ */ new Set([...x, ...y])];
}
var CLAUDE_WRITE_TOOLS = {
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path"
};
var CLAUDE_READ_TOOLS = {
  Read: "file_path",
  Glob: "path",
  Grep: "path"
};
function claudeToolEvidence(block) {
  const name = typeof block.name === "string" ? block.name : "";
  const input = isObject(block.input) ? block.input : {};
  const writeField = CLAUDE_WRITE_TOOLS[name];
  if (writeField) return { writes: absolute(input[writeField]), reads: [] };
  const readField = CLAUDE_READ_TOOLS[name];
  if (readField) return { writes: [], reads: absolute(input[readField]) };
  if (name === "Bash") return { writes: [], reads: bashPaths(typeof input.command === "string" ? input.command : "") };
  return { writes: [], reads: [] };
}
var SYSTEM_PREFIXES = ["/dev", "/proc", "/sys", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];
var BASH_PATH = /(?:^|[\s=:;|&(<>'"`])(?:'((?:[A-Za-z]:[\\/]|\/)[^']+)'|"((?:[A-Za-z]:[\\/]|\/)[^"]+)"|((?:[A-Za-z]:[\\/]|\/)[^\s'"`;|&<>()]+))/g;
function bashPaths(command2) {
  const out = [];
  for (const m of command2.matchAll(BASH_PATH)) {
    const path = m[1] ?? m[2] ?? m[3];
    if (!path) continue;
    if (path.startsWith("//")) continue;
    if (SYSTEM_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) continue;
    if (!out.includes(path)) out.push(path);
  }
  return out;
}
function codexCallEvidence(name, argumentsJson, cwd) {
  if (typeof name !== "string" || typeof argumentsJson !== "string") return { writes: [], reads: [] };
  let args;
  try {
    args = JSON.parse(argumentsJson);
  } catch {
    return { writes: [], reads: [] };
  }
  if (!isObject(args)) return { writes: [], reads: [] };
  if (name === "shell" || name === "shell_command" || name === "exec_command" || name === "local_shell") {
    const reads = [];
    const workdir = args.workdir;
    if (typeof workdir === "string" && isAbsolute(workdir)) reads.push(workdir);
    const command2 = Array.isArray(args.command) ? args.command.filter((c) => typeof c === "string").join(" ") : typeof args.command === "string" ? args.command : "";
    for (const p of bashPaths(command2)) if (!reads.includes(p)) reads.push(p);
    return { writes: [], reads };
  }
  if (name === "apply_patch") {
    const patch = typeof args.input === "string" ? args.input : typeof args.patch === "string" ? args.patch : "";
    const writes = [];
    for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
      const rel = m[1].trim();
      const abs = isAbsolute(rel) ? rel : join(cwd, rel);
      if (!writes.includes(abs)) writes.push(abs);
    }
    return { writes, reads: [] };
  }
  return { writes: [], reads: [] };
}
function absolute(v) {
  return typeof v === "string" && isAbsolute(v) ? [v] : [];
}
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ../parsers/src/providers/claude-code.ts
function claudeConfigDirs() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && env.trim()) {
    return env.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [
    join2(homedir(), ".claude"),
    join2(homedir(), ".config", "claude"),
    // Xcode's Claude agent keeps its own config (phuryn/claude-usage scanner.py:21).
    join2(homedir(), "Library", "Developer", "Xcode", "CodingAssistant", "ClaudeAgentConfig")
  ];
}
function claudeProjectDirs() {
  return claudeConfigDirs().map((d) => basename(d.replace(/[\\/]+$/, "")) === "projects" ? d : join2(d, "projects"));
}
async function scanClaudeCodeLogs(opts) {
  const since = opts.since;
  const bases = opts.basePath ? [opts.basePath] : claudeProjectDirs();
  const files = [];
  for (const base of bases) for (const path of await listTranscripts(base, since)) files.push(path);
  const events = [];
  for (let i = 0; i < files.length; i++) {
    await readTranscript(files[i], events);
    opts.onFile?.(i + 1, files.length);
  }
  const folded = foldSidechainReplays(events);
  if (!since) return collapseUsageEvents(folded);
  const inWindow = new Set(folded.filter((e) => e.occurredAt > since).map((e) => e.externalId));
  const collapsed = collapseUsageEvents(folded);
  if (!opts.wholeFiles) return collapsed.filter((e) => inWindow.has(e.externalId));
  for (const e of collapsed) if (!inWindow.has(e.externalId)) e.metadata.context = true;
  return collapsed;
}
function foldSidechainReplays(events) {
  const parentId = /* @__PURE__ */ new Map();
  for (const e of events) {
    const m = e.metadata;
    if (m.isSidechain === true || !m.messageId) continue;
    const k = `${m.sessionId ?? ""}\0${m.messageId}`;
    if (!parentId.has(k)) parentId.set(k, e.externalId);
  }
  for (const e of events) {
    const m = e.metadata;
    if (m.isSidechain !== true || !m.messageId) continue;
    const id = parentId.get(`${m.sessionId ?? ""}\0${m.messageId}`);
    if (id && !/:(iter|advisor):\d+$/.test(e.externalId)) e.externalId = id;
  }
  return events;
}
function collapseUsageEvents(events) {
  const byId = /* @__PURE__ */ new Map();
  for (const e of events) {
    const prev = byId.get(e.externalId);
    if (!prev) {
      byId.set(e.externalId, e);
      continue;
    }
    const prevSide = prev.metadata.isSidechain === true;
    const nextSide = e.metadata.isSidechain === true;
    if (prevSide !== nextSide) {
      if (prevSide) byId.set(e.externalId, e);
      continue;
    }
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
    if (e.speed && (!prev.speed || prev.speed === "standard")) prev.speed = e.speed;
    if (e.webSearchRequests) prev.webSearchRequests = Math.max(prev.webSearchRequests ?? 0, e.webSearchRequests);
    if (e.cacheWriteTokens !== void 0) {
      prev.cacheWriteTokens = Math.max(prev.cacheWriteTokens ?? 0, e.cacheWriteTokens);
    }
    if (e.metadata.touched) prev.metadata.touched = mergeEvidence(prev.metadata.touched, e.metadata.touched);
    if (!prev.metadata.turn) prev.metadata.turn = e.metadata.turn;
    if (e.occurredAt < prev.occurredAt) prev.occurredAt = e.occurredAt;
  }
  return [...byId.values()];
}
function usageExternalId(raw, message) {
  if (typeof raw.requestId === "string" && raw.requestId.length > 0) return raw.requestId;
  const messageId = message.id;
  if (typeof messageId !== "string" || messageId.length === 0) return null;
  return `msg:${messageId}`;
}
async function listTranscripts(basePath, since) {
  let entries;
  try {
    entries = await readdir(basePath);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const files = [];
  for (const entry of entries) {
    const dir = join2(basePath, entry);
    let dirStat;
    try {
      dirStat = await stat(dir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    for (const path of await listSessionFiles(dir)) {
      let fileStat;
      try {
        fileStat = await stat(path);
      } catch {
        continue;
      }
      if (since && Math.max(fileStat.mtimeMs, fileStat.ctimeMs) < since.getTime()) continue;
      files.push(path);
    }
  }
  return files;
}
async function readTranscript(path, events) {
  let content;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return;
  }
  const turns = new TurnCounter(basename(path, ".jsonl"));
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    turns.observe(raw);
    const parsed = parseAssistantEvent(raw, turns.current);
    if (parsed) {
      applyFallback(raw, parsed);
      events.push(parsed);
      for (const extra of extraIterations(raw, parsed)) events.push(extra);
    }
  }
}
async function listSessionFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      if (entry.name.endsWith(".jsonl")) files.push(join2(dir, entry.name));
      continue;
    }
    if (!entry.isDirectory()) continue;
    const sub = join2(dir, entry.name, "subagents");
    files.push(...await listJsonlBelow(sub, 8));
  }
  return files;
}
async function listJsonlBelow(dir, remainingDepth) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const path = join2(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    } else if (entry.isDirectory() && remainingDepth > 0) {
      files.push(...await listJsonlBelow(path, remainingDepth - 1));
    }
  }
  return files;
}
var TurnCounter = class {
  constructor(scope) {
    this.scope = scope;
  }
  n = 0;
  get current() {
    return `${this.scope}#${this.n}`;
  }
  observe(raw) {
    if (!isObject2(raw) || raw.type !== "user" || raw.isMeta === true) return;
    const message = raw.message;
    if (!isObject2(message)) return;
    const content = message.content;
    if (typeof content === "string") this.n++;
    else if (Array.isArray(content) && !content.some((b) => isObject2(b) && b.type === "tool_result")) this.n++;
  }
};
function lineEvidence(message) {
  let out = { writes: [], reads: [] };
  if (!Array.isArray(message.content)) return out;
  for (const block of message.content) {
    if (isObject2(block) && block.type === "tool_use") out = mergeEvidence(out, claudeToolEvidence({ name: block.name, input: block.input }));
  }
  return out;
}
function extraIterations(raw, top) {
  const iterations = iterationsOf(raw);
  if (iterations.length < 2) return [];
  const firstFallback = iterations.findIndex((it) => it.type === "fallback_message");
  const out = [];
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
      metadata: { ...top.metadata, touched: { writes: [], reads: [] }, fallback: void 0 }
    });
  });
  return out;
}
function iterationsOf(raw) {
  if (!isObject2(raw) || !isObject2(raw.message) || !isObject2(raw.message.usage)) return [];
  const it = raw.message.usage.iterations;
  return Array.isArray(it) ? it.filter(isObject2) : [];
}
function usageFields(u) {
  const cc = isObject2(u.cache_creation) ? u.cache_creation : null;
  return {
    inputTokens: numOr0(u.input_tokens),
    outputTokens: numOr0(u.output_tokens),
    cacheReadTokens: numOr0(u.cache_read_input_tokens),
    cacheCreationTokens: numOr0(u.cache_creation_input_tokens),
    cacheCreation5mTokens: cc ? numOr0(cc.ephemeral_5m_input_tokens) : 0,
    cacheCreation1hTokens: cc ? numOr0(cc.ephemeral_1h_input_tokens) : 0
  };
}
function applyFallback(raw, e) {
  const iterations = iterationsOf(raw);
  const fb = [...iterations].reverse().find((it) => it.type === "fallback_message");
  if (!fb) return;
  Object.assign(e, usageFields(fb));
  if (typeof fb.model === "string" && fb.model) e.model = fb.model;
  e.metadata.fallback = true;
}
function parseAssistantEvent(raw, turn) {
  if (!isObject2(raw)) return null;
  if (raw.type !== "assistant") return null;
  const message = raw.message;
  if (!isObject2(message)) return null;
  const usage = message.usage;
  if (!isObject2(usage)) return null;
  const model = message.model;
  const timestamp = raw.timestamp;
  if (typeof model !== "string") return null;
  if (typeof timestamp !== "string") return null;
  const externalId = usageExternalId(raw, message);
  if (!externalId) return null;
  if (model === "<synthetic>") return null;
  const occurredAt = new Date(timestamp);
  if (Number.isNaN(occurredAt.getTime())) return null;
  const cacheCreationTotal = numOr0(usage.cache_creation_input_tokens);
  const cc = isObject2(usage.cache_creation) ? usage.cache_creation : null;
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
    ...usageExtras(usage),
    metadata: {
      cwd: stringOr(raw.cwd),
      gitBranch: stringOr(raw.gitBranch),
      sessionId: stringOr(raw.sessionId),
      version,
      entrypoint,
      isSidechain: boolOr(raw.isSidechain),
      turn,
      touched: lineEvidence(message),
      messageId: stringOr(message.id)
    }
  };
}
function usageExtras(usage) {
  const out = {};
  if (typeof usage.speed === "string" && /^[a-z_-]{1,32}$/.test(usage.speed)) out.speed = usage.speed;
  const web = isObject2(usage.server_tool_use) ? usage.server_tool_use.web_search_requests : void 0;
  if (typeof web === "number" && Number.isInteger(web) && web > 0 && web <= 1e4) out.webSearchRequests = web;
  return out;
}
function isObject2(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function numOr0(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function stringOr(v) {
  return typeof v === "string" ? v : void 0;
}
function boolOr(v) {
  return typeof v === "boolean" ? v : void 0;
}

// ../parsers/src/providers/copilot-cli.ts
import { readdir as readdir2, readFile as readFile2, stat as stat2 } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";

// ../parsers/src/providers/external-id.ts
function suffixDuplicateExternalIds(events) {
  const seen = /* @__PURE__ */ new Map();
  for (const event of events) {
    const n = (seen.get(event.externalId) ?? 0) + 1;
    seen.set(event.externalId, n);
    if (n > 1) event.externalId = `${event.externalId}:${n}`;
  }
  return events;
}

// ../parsers/src/providers/copilot-cli.ts
var DEFAULT_BASE_PATH = join3(homedir2(), ".copilot", "session-state");
async function scanCopilotLogs(opts) {
  const basePath = opts.basePath ?? DEFAULT_BASE_PATH;
  let entries;
  try {
    entries = await readdir2(basePath);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const events = /* @__PURE__ */ new Map();
  const changedSessions = /* @__PURE__ */ new Set();
  const conflicts = /* @__PURE__ */ new Set();
  entries.sort();
  for (let i = 0; i < entries.length; i++) {
    const parsed = [];
    await readSession(basePath, entries[i], parsed);
    if (opts.since && opts.wholeFiles && parsed.length) {
      try {
        const files = await Promise.all([stat2(join3(basePath, entries[i], "events.jsonl")), stat2(join3(basePath, entries[i], "workspace.yaml"))]);
        if (files.some((file) => Math.max(file.mtimeMs, file.ctimeMs) >= opts.since.getTime())) {
          changedSessions.add(parsed[0].metadata.sessionId);
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const baseIds = new Map(parsed.map((event) => [event, event.externalId]));
    for (const event of suffixDuplicateExternalIds(parsed)) {
      const baseId = baseIds.get(event);
      const fingerprint = JSON.stringify([event.model, event.inputTokens, event.outputTokens, event.cacheReadTokens, event.cacheWriteTokens]);
      const previous = events.get(event.externalId);
      if (previous && previous.fingerprint !== fingerprint) {
        if (!conflicts.has(baseId)) opts.onIssue?.({ reason: "conflicting_copy", externalId: baseId });
        conflicts.add(baseId);
      }
      if (!previous) events.set(event.externalId, { event, baseId, fingerprint });
    }
    opts.onFile?.(i + 1, entries.length);
  }
  return [...events.values()].filter(({ event, baseId }) => !conflicts.has(baseId) && (!opts.since || (opts.wholeFiles ? changedSessions.has(event.metadata.sessionId) : event.occurredAt > opts.since))).map(({ event }) => event);
}
async function readSession(basePath, entry, events) {
  const dir = join3(basePath, entry);
  let dirStat;
  try {
    dirStat = await stat2(dir);
  } catch {
    return;
  }
  if (!dirStat.isDirectory()) return;
  const ws = await readWorkspace(join3(dir, "workspace.yaml"));
  if (!ws) return;
  const sessionStart = new Date(ws.created_at ?? "");
  const segments = await readShutdownSegments(join3(dir, "events.jsonl"));
  const sessionId = ws.id ?? entry;
  for (const segment of segments) {
    const segDate = new Date(segment.timestamp ?? "");
    const occurredAt = Number.isNaN(segDate.getTime()) ? sessionStart : segDate;
    if (Number.isNaN(occurredAt.getTime())) continue;
    for (const [model, m] of Object.entries(segment.modelMetrics)) {
      const usage = isObject3(m) && isObject3(m.usage) ? m.usage : null;
      if (!usage) continue;
      events.push({
        externalId: `${sessionId}:${model}:${occurredAt.toISOString()}`,
        provider: "openai",
        // advisory only; server re-derives from model
        model,
        inputTokens: numOr02(usage.inputTokens),
        outputTokens: numOr02(usage.outputTokens),
        cacheReadTokens: numOr02(usage.cacheReadTokens),
        cacheCreationTokens: numOr02(usage.cacheWriteTokens),
        cacheWriteTokens: numOr02(usage.cacheWriteTokens),
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
        occurredAt,
        metadata: {
          cwd: ws.cwd,
          gitBranch: ws.branch,
          sessionId
        }
      });
    }
  }
}
async function readWorkspace(path) {
  let content;
  try {
    content = await readFile2(path, "utf-8");
  } catch {
    return null;
  }
  const out = {};
  for (const line of content.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}
async function readShutdownSegments(path) {
  let content;
  try {
    content = await readFile2(path, "utf-8");
  } catch {
    return [];
  }
  const segments = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (isObject3(raw) && raw.type === "session.shutdown" && isObject3(raw.data) && isObject3(raw.data.modelMetrics)) {
      segments.push({
        timestamp: typeof raw.timestamp === "string" ? raw.timestamp : void 0,
        modelMetrics: raw.data.modelMetrics
      });
    }
  }
  return segments;
}
function isObject3(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function numOr02(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ../parsers/src/providers/codex.ts
import { readdir as readdir3, readFile as readFile3, stat as stat3 } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { join as join4 } from "node:path";
function codexHomeDir() {
  return codexHomeDirs()[0];
}
function codexHomeDirs() {
  const configured = process.env.CODEX_HOME;
  if (!configured) return [join4(homedir3(), ".codex")];
  const dirs = configured.split(",").map((dir) => dir.trim()).filter(Boolean);
  return dirs.length > 0 ? dirs : [join4(homedir3(), ".codex")];
}
async function scanCodexLogs(opts) {
  const files = opts.basePath ? await findJsonlFiles(opts.basePath) : await findCodexUsageFiles();
  const eventsById = /* @__PURE__ */ new Map();
  const conflicts = /* @__PURE__ */ new Set();
  const metaByPath = /* @__PURE__ */ new Map();
  for (const path of files) metaByPath.set(path, await readForkMeta(path));
  const pathBySession = /* @__PURE__ */ new Map();
  for (const [path, m] of metaByPath) if (m.sessionId && !pathBySession.has(m.sessionId)) pathBySession.set(m.sessionId, path);
  const parents = /* @__PURE__ */ new Map();
  const selected = /* @__PURE__ */ new Set();
  const changedSessions = /* @__PURE__ */ new Set();
  for (const path of files) {
    if (opts.since) {
      try {
        const info = await stat3(path);
        if (Math.max(info.mtimeMs, info.ctimeMs) < opts.since.getTime()) continue;
      } catch {
        continue;
      }
    }
    selected.add(path);
    const sessionId = metaByPath.get(path)?.sessionId;
    if (sessionId) changedSessions.add(sessionId);
  }
  const toRead = files.filter((path) => selected.has(path) || changedSessions.has(metaByPath.get(path)?.sessionId ?? ""));
  for (let i = 0; i < toRead.length; i++) {
    const path = toRead[i];
    let parsed = await parseSession(path, void 0);
    const fork = metaByPath.get(path);
    if (fork?.forkedFrom) parsed = await dropForkReplay(parsed, fork, pathBySession.get(fork.forkedFrom), parents);
    const baseIds = new Map(parsed.map((event) => [event, event.externalId]));
    parsed = suffixDuplicateExternalIds(parsed);
    for (const e of parsed) {
      if (opts.since && e.occurredAt <= opts.since) {
        if (!opts.wholeFiles) continue;
        e.metadata.context = true;
      }
      const previous = eventsById.get(e.externalId);
      const baseId = baseIds.get(e);
      const fingerprint = JSON.stringify([
        e.provider,
        e.model,
        e.inputTokens,
        e.outputTokens,
        e.cacheReadTokens,
        e.cacheWriteTokens,
        e.cacheCreation5mTokens,
        e.cacheCreation1hTokens
      ]);
      if (previous && previous.fingerprint !== fingerprint) {
        if (!conflicts.has(baseId)) opts.onIssue?.({ reason: "conflicting_copy", externalId: baseId });
        conflicts.add(baseId);
      }
      if (!previous) eventsById.set(e.externalId, { event: e, fingerprint, baseId });
    }
    opts.onFile?.(i + 1, toRead.length);
  }
  return [...eventsById.values()].filter(({ baseId }) => !conflicts.has(baseId)).map(({ event }) => event);
}
var replayEvidence = /* @__PURE__ */ new WeakMap();
async function readForkMeta(path) {
  let content;
  try {
    content = await readFile3(path, "utf-8");
  } catch {
    return {};
  }
  for (const line of content.split("\n", 50)) {
    if (!line.includes('"session_meta"')) continue;
    try {
      const raw = JSON.parse(line);
      const p = isObject4(raw.payload) ? raw.payload : {};
      const at = stringOr2(p.timestamp) ?? stringOr2(raw.timestamp);
      return {
        sessionId: stringOr2(p.session_id) ?? stringOr2(p.id),
        forkedFrom: stringOr2(p.forked_from_id),
        forkedAt: at ? new Date(at) : void 0
      };
    } catch {
      return {};
    }
  }
  return {};
}
async function dropForkReplay(child, fork, parentPath, parents) {
  if (!parentPath) return child;
  let parent = parents.get(parentPath);
  if (!parent) {
    parent = await parseSession(parentPath, void 0);
    parents.set(parentPath, parent);
  }
  const at = fork.forkedAt?.getTime();
  if (at === void 0 || Number.isNaN(at)) return child;
  const eligible = parent.filter((event) => event.occurredAt.getTime() <= at);
  let cursor = 0;
  let replayed = 0;
  for (const event of child) {
    const evidence = replayEvidence.get(event);
    if (!evidence) break;
    const match = eligible.findIndex((candidate, index) => index >= cursor && replayEvidence.get(candidate) === evidence);
    if (match < 0) break;
    cursor = match + 1;
    replayed++;
  }
  return child.slice(replayed);
}
async function findCodexUsageFiles() {
  const files = [];
  for (const home of codexHomeDirs()) {
    const roots = [join4(home, "sessions"), join4(home, "archived_sessions")];
    let foundStandardRoot = false;
    for (const root of roots) {
      if (!await isDirectory(root)) continue;
      foundStandardRoot = true;
      for (const path of await findJsonlFiles(root)) {
        files.push(path);
      }
    }
    if (!foundStandardRoot) for (const f of await findJsonlFiles(home)) files.push(f);
  }
  return files;
}
async function isDirectory(path) {
  try {
    return (await stat3(path)).isDirectory();
  } catch {
    return false;
  }
}
async function findJsonlFiles(basePath) {
  let entries;
  try {
    entries = await readdir3(basePath, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const files = [];
  for (const entry of entries) {
    const path = join4(basePath, entry.name);
    if (entry.isDirectory()) for (const f of await findJsonlFiles(path)) files.push(f);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}
async function parseSession(path, since) {
  let content;
  try {
    content = await readFile3(path, "utf-8");
  } catch {
    return [];
  }
  const context2 = {};
  const events = [];
  let previousTotals = null;
  let baselineValid = true;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject4(raw) || !isObject4(raw.payload)) continue;
    if (raw.type === "session_meta") {
      readSessionMeta(raw.payload, context2);
      continue;
    }
    if (raw.type === "turn_context") {
      readTurnContext(raw.payload, context2);
      continue;
    }
    if (raw.type === "response_item" && raw.payload.type === "function_call") {
      context2.touched = mergeEvidence(context2.touched, codexCallEvidence(raw.payload.name, raw.payload.arguments, context2.cwd ?? "/"));
      continue;
    }
    if (raw.type !== "event_msg" || raw.payload.type !== "token_count") continue;
    const parsed = parseTokenCount(raw, context2, previousTotals, baselineValid);
    if (parsed.total) {
      previousTotals = parsed.total;
      baselineValid = true;
    } else if (parsed.bareLast) {
      baselineValid = false;
    }
    const event = parsed.event;
    if (event) {
      const info = isObject4(raw.payload.info) ? raw.payload.info : {};
      const total = readTokenUsage(info.total_token_usage);
      const last = readTokenUsage(info.last_token_usage);
      if (total && last) replayEvidence.set(event, JSON.stringify([event.model, total, last]));
      if (!since || event.occurredAt > since) events.push(event);
    }
  }
  return events;
}
function readSessionMeta(payload, context2) {
  context2.sessionId = stringOr2(payload.session_id) ?? stringOr2(payload.id);
  context2.cwd = stringOr2(payload.cwd);
  context2.client = stringOr2(payload.originator) ?? stringOr2(payload.source);
  context2.clientVersion = stringOr2(payload.cli_version);
  if (isObject4(payload.git)) context2.gitBranch = stringOr2(payload.git.branch);
}
function readTurnContext(payload, context2) {
  const turnId = stringOr2(payload.turn_id);
  if (turnId !== context2.turnId) context2.touched = void 0;
  context2.turnId = turnId;
  context2.model = stringOr2(payload.model);
  context2.cwd = stringOr2(payload.cwd) ?? context2.cwd;
}
function parseTokenCount(raw, context2, previousTotals, baselineValid) {
  const timestamp = stringOr2(raw.timestamp);
  if (!timestamp || !context2.sessionId) return { event: null, total: null, bareLast: false };
  const occurredAt = new Date(timestamp);
  if (Number.isNaN(occurredAt.getTime())) return { event: null, total: null, bareLast: false };
  const payload = raw.payload;
  if (!isObject4(payload) || !isObject4(payload.info)) {
    return { event: null, total: null, bareLast: false };
  }
  const info = payload.info;
  const total = readTokenUsage(info.total_token_usage);
  const last = readTokenUsage(info.last_token_usage);
  if (total && previousTotals && sameUsage(total, previousTotals)) {
    return { event: null, total, bareLast: false };
  }
  if (total && previousTotals && last && looksStale(total, previousTotals, last)) {
    return { event: null, total: previousTotals, bareLast: false };
  }
  const usage = last ?? (total && baselineValid ? subtractTokenUsage(total, previousTotals) : null);
  const bareLast = last !== null && total === null;
  const model = stringOr2(payload.model) ?? stringOr2(info.model) ?? context2.model;
  if (!usage || !model) return { event: null, total, bareLast };
  const totalInput = usage.inputTokens;
  const cacheRead = usage.cachedInputTokens;
  const cacheWrite = usage.cacheWriteInputTokens;
  const input = Math.max(0, totalInput - cacheRead - cacheWrite);
  const turn = context2.turnId ?? "turn-unknown";
  return {
    event: {
      externalId: `${context2.sessionId}:${turn}:${occurredAt.toISOString()}`,
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
        cwd: context2.cwd,
        gitBranch: context2.gitBranch,
        sessionId: context2.sessionId,
        version: context2.clientVersion,
        entrypoint: context2.client,
        turn: context2.turnId ? `${context2.sessionId}#${context2.turnId}` : void 0,
        touched: context2.touched ? { writes: [...context2.touched.writes], reads: [...context2.touched.reads] } : { writes: [], reads: [] }
      }
    },
    total,
    bareLast
  };
}
function readTokenUsage(raw) {
  if (!isObject4(raw)) return null;
  return {
    inputTokens: numOr03(raw.input_tokens),
    cachedInputTokens: numOr03(raw.cached_input_tokens),
    cacheWriteInputTokens: numOr03(raw.cache_write_input_tokens),
    outputTokens: numOr03(raw.output_tokens)
  };
}
function usageSum(u) {
  return u.inputTokens + u.outputTokens;
}
function looksStale(current, previous, last) {
  const cur = usageSum(current);
  const prev = usageSum(previous);
  if (cur >= prev || cur <= 0 || usageSum(last) <= 0) return false;
  return cur * 100 >= prev * 98 || cur + 2 * usageSum(last) >= prev;
}
function sameUsage(a, b) {
  return a.inputTokens === b.inputTokens && a.cachedInputTokens === b.cachedInputTokens && a.cacheWriteInputTokens === b.cacheWriteInputTokens && a.outputTokens === b.outputTokens;
}
function subtractTokenUsage(current, previous) {
  return {
    inputTokens: Math.max(0, current.inputTokens - (previous?.inputTokens ?? 0)),
    cachedInputTokens: Math.max(
      0,
      current.cachedInputTokens - (previous?.cachedInputTokens ?? 0)
    ),
    cacheWriteInputTokens: Math.max(
      0,
      current.cacheWriteInputTokens - (previous?.cacheWriteInputTokens ?? 0)
    ),
    outputTokens: Math.max(0, current.outputTokens - (previous?.outputTokens ?? 0))
  };
}
function isObject4(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function numOr03(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}
function stringOr2(v) {
  return typeof v === "string" && v.length > 0 ? v : void 0;
}

// ../parsers/src/providers/pi.ts
import { createHash } from "node:crypto";
import { readdir as readdir4, readFile as readFile4, stat as stat4 } from "node:fs/promises";
import { homedir as homedir4 } from "node:os";
import { join as join5 } from "node:path";
function piSessionsDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  const agentDir = configured === "~" ? homedir4() : configured?.startsWith("~/") || configured?.startsWith("~\\") ? join5(homedir4(), configured.slice(2)) : configured || join5(homedir4(), ".pi", "agent");
  return join5(agentDir, "sessions");
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 240 && !/[\u0000-\u001F\u007F\uD800-\uDFFF\uFFFD]/u.test(value);
}
function count(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1e9;
}
async function filesUnder(root) {
  let entries;
  try {
    entries = await readdir4(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join5(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}
function parseFile(bytes, onIssue) {
  let session;
  const events = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(10, start);
    const end = newline === -1 ? bytes.length : newline;
    const rawLine = bytes.subarray(start, end);
    start = end + 1;
    let line;
    try {
      line = decoder.decode(rawLine);
    } catch {
      continue;
    }
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
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
    if (!object(message.usage)) {
      invalid();
      continue;
    }
    const usage = message.usage;
    if (![usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(count)) {
      invalid();
      continue;
    }
    if (usage.cacheWrite1h !== void 0 && (!count(usage.cacheWrite1h) || usage.cacheWrite1h > usage.cacheWrite)) {
      invalid();
      continue;
    }
    if (!text(message.model) || !text(message.provider) || !text(entry.timestamp)) {
      invalid();
      continue;
    }
    const occurredAt = new Date(entry.timestamp);
    if (!Number.isFinite(occurredAt.getTime())) {
      invalid();
      continue;
    }
    if (!text(message.responseId) && !text(entry.id)) {
      invalid();
      continue;
    }
    const identity = text(message.responseId) ? ["response", message.provider, message.responseId] : ["entry", message.provider, message.model, entry.id, occurredAt.toISOString()];
    const externalId = `pi:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
    events.push({
      externalId,
      provider: message.provider,
      model: message.model,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite - (message.provider === "anthropic" ? usage.cacheWrite1h ?? 0 : 0),
      cacheCreationTokens: usage.cacheWrite,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: usage.cacheWrite1h ?? 0,
      occurredAt,
      metadata: {
        sessionId: `pi:${session.id}`,
        ...text(session.cwd) ? { cwd: session.cwd } : {},
        ...text(entry.id) ? { messageId: entry.id } : {}
      }
    });
  }
  return events;
}
async function scanPiLogs(opts = {}) {
  const files = await filesUnder(opts.basePath ?? piSessionsDir());
  const events = [];
  const seen = /* @__PURE__ */ new Set();
  const identities = /* @__PURE__ */ new Map();
  const conflicts = /* @__PURE__ */ new Set();
  const selected = /* @__PURE__ */ new Set();
  for (const [index, path] of files.entries()) {
    try {
      const info = await stat4(path);
      const changed = !opts.since || Math.max(info.mtimeMs, info.ctimeMs) >= opts.since.getTime();
      for (const event of parseFile(await readFile4(path), changed ? opts.onIssue : void 0)) {
        if (changed) selected.add(event.externalId);
        const fingerprint = JSON.stringify([
          event.externalId,
          event.model,
          event.occurredAt.toISOString(),
          event.inputTokens,
          event.outputTokens,
          event.cacheReadTokens,
          event.cacheWriteTokens,
          event.cacheCreation1hTokens
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
      if (error.code !== "ENOENT") throw error;
    } finally {
      opts.onFile?.(index + 1, files.length);
    }
  }
  for (const externalId of conflicts) {
    if (selected.has(externalId)) opts.onIssue?.({ reason: "conflicting_usage", externalId });
  }
  return events.filter((event) => selected.has(event.externalId) && !conflicts.has(event.externalId));
}

// ../parsers/src/providers/gemini.ts
import { createHash as createHash2 } from "node:crypto";
import { readdir as readdir5, readFile as readFile5, stat as stat5 } from "node:fs/promises";
import { homedir as homedir5 } from "node:os";
import { basename as basename2, dirname, join as join6 } from "node:path";
var isObject5 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var isText = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 240 && !/[\u0000-\u001F\u007F\uD800-\uDFFF\uFFFD]/u.test(value);
var isCount = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1e9;
function geminiSessionsDirs() {
  const home = process.env.GEMINI_CLI_HOME || homedir5();
  return [join6(home, ".gemini", "tmp"), join6(home, ".cache", ".gemini", "tmp")];
}
async function discover(root) {
  let entries;
  try {
    entries = await readdir5(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join6(root, entry.name);
    if (entry.isDirectory()) files.push(...await discover(path));
    else if (entry.isFile() && /\.(json|jsonl)$/.test(entry.name) && (entry.name.startsWith("session-") || basename2(dirname(path)) === "chats")) files.push(path);
  }
  return files;
}
function eventFor(message, sessionId, onIssue) {
  if (message.type !== "gemini" || !isText(message.id) || !isText(message.model) || !isText(message.timestamp) || !isObject5(message.tokens)) return;
  const occurredAt = new Date(message.timestamp);
  if (!Number.isFinite(occurredAt.getTime())) return;
  const externalId = `gemini:${createHash2("sha256").update(JSON.stringify([message.id, message.timestamp])).digest("hex")}`;
  const tokens = message.tokens;
  const thoughts = tokens.thoughts ?? 0;
  const tool = tokens.tool ?? 0;
  if (![tokens.input, tokens.output, tokens.cached, tokens.total, thoughts, tool].every(isCount) || tokens.cached > tokens.input) {
    onIssue?.({ reason: "invalid_usage", externalId });
    return;
  }
  if (tool !== 0) {
    onIssue?.({ reason: "unsupported_tool_usage", externalId });
    return;
  }
  const output = tokens.output + thoughts;
  if (!isCount(output) || tokens.input + output !== tokens.total) {
    onIssue?.({ reason: "invalid_usage", externalId });
    return;
  }
  return {
    externalId,
    provider: "google",
    model: message.model,
    inputTokens: tokens.input - tokens.cached,
    outputTokens: output,
    cacheReadTokens: tokens.cached,
    cacheCreationTokens: 0,
    cacheWriteTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    occurredAt,
    metadata: { sessionId: `gemini:${sessionId}`, messageId: message.id }
  };
}
function parseRecords(bytes, jsonl, onIssue) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records = [];
  if (!jsonl) {
    try {
      records.push(JSON.parse(decoder.decode(bytes)));
    } catch {
      return [];
    }
  } else {
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline === -1 ? bytes.length : newline;
      const line = bytes.subarray(start, end);
      start = end + 1;
      try {
        records.push(JSON.parse(decoder.decode(line)));
      } catch {
      }
    }
  }
  let sessionId;
  const latest = /* @__PURE__ */ new Map();
  const recordMessage = (value) => {
    if (isObject5(value) && value.type === "gemini" && isText(value.id) && isObject5(value.tokens)) latest.set(value.id, value);
  };
  for (const record of records) {
    if (!isObject5(record)) continue;
    const metadata = isObject5(record.$set) ? record.$set : record;
    if (isText(metadata.sessionId)) {
      if (sessionId && sessionId !== metadata.sessionId) return [];
      sessionId = metadata.sessionId;
    }
    if (Array.isArray(metadata.messages)) metadata.messages.forEach(recordMessage);
    recordMessage(record);
  }
  if (!sessionId) return [];
  return [...latest.values()].flatMap((message) => {
    const event = eventFor(message, sessionId, onIssue);
    return event ? [event] : [];
  });
}
async function scanGeminiLogs(opts = {}) {
  const roots = opts.basePath === void 0 ? geminiSessionsDirs() : [opts.basePath];
  const files = (await Promise.all(roots.map(discover))).flat();
  const events = /* @__PURE__ */ new Map();
  const fingerprints = /* @__PURE__ */ new Map();
  const conflicts = /* @__PURE__ */ new Set();
  const selected = /* @__PURE__ */ new Set();
  for (const [index, file] of files.entries()) {
    try {
      const info = await stat5(file);
      const changed = !opts.since || Math.max(info.mtimeMs, info.ctimeMs) >= opts.since.getTime();
      for (const event of parseRecords(await readFile5(file), file.endsWith(".jsonl"), changed ? opts.onIssue : void 0)) {
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
      if (error.code !== "ENOENT") throw error;
    } finally {
      opts.onFile?.(index + 1, files.length);
    }
  }
  for (const externalId of conflicts) {
    if (selected.has(externalId)) opts.onIssue?.({ reason: "conflicting_usage", externalId });
  }
  return [...events.values()].filter((event) => selected.has(event.externalId) && !conflicts.has(event.externalId));
}

// ../parsers/src/providers/git-attribution.ts
var RECORD_SEP = "";
var UNIT_SEP = "";
function parseGitLogNumstat(text2) {
  const commits = [];
  for (const record of text2.split(RECORD_SEP)) {
    if (!record.trim()) continue;
    const lines = record.split("\n");
    const [sha, iso, email] = lines[0].split(UNIT_SEP);
    if (!sha || !iso) continue;
    const authorEmail = email?.trim() ? email.trim().toLowerCase() : void 0;
    const committedAt = new Date(iso);
    if (Number.isNaN(committedAt.getTime())) continue;
    let linesAdded = 0;
    let linesDeleted = 0;
    let filesChanged = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const [addedRaw, deletedRaw] = line.split("	");
      filesChanged++;
      linesAdded += addedRaw === "-" ? 0 : Number.parseInt(addedRaw, 10) || 0;
      linesDeleted += deletedRaw === "-" ? 0 : Number.parseInt(deletedRaw, 10) || 0;
    }
    commits.push({ sha, committedAt, linesAdded, linesDeleted, filesChanged, ...authorEmail ? { authorEmail } : {} });
  }
  return commits;
}
function matchEventsToCommits(events, commits) {
  if (commits.length === 0) return [];
  const sorted = [...commits].sort(
    (a, b) => a.committedAt.getTime() - b.committedAt.getTime() || (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0)
  );
  const out = [];
  for (const ev of events) {
    const t = ev.occurredAt.getTime();
    const commit = sorted.find((c) => c.committedAt.getTime() >= t);
    if (!commit) continue;
    out.push({
      externalId: ev.externalId,
      sha: commit.sha,
      committedAt: commit.committedAt,
      linesAdded: commit.linesAdded,
      linesDeleted: commit.linesDeleted,
      filesChanged: commit.filesChanged
    });
  }
  return out;
}

// ../parsers/src/providers/ship-status.ts
var UNSHIPPED_AFTER_DAYS = 14;
var DAY_MS = 24 * 60 * 60 * 1e3;
function computeCommitFates(facts) {
  const ancestors = new Set(facts.ancestorShas);
  const cherryEquivalent = new Set(facts.cherryEquivalentShas);
  const nowMs = Date.parse(facts.now);
  const freshWindowMs = UNSHIPPED_AFTER_DAYS * DAY_MS;
  const isDefault = (b) => b === facts.defaultBranch || b === `origin/${facts.defaultBranch}`;
  const out = [];
  for (const { sha } of facts.shas) {
    const containing = facts.branchesBySha[sha] ?? [];
    const shippedViaAncestry = ancestors.has(sha);
    let branch;
    if (shippedViaAncestry) {
      branch = containing.length > 0 ? facts.defaultBranch : null;
    } else {
      const nonDefault = containing.filter((b) => !isDefault(b));
      const local = nonDefault.find((b) => !b.startsWith("origin/"));
      const remote = nonDefault.find((b) => b.startsWith("origin/"));
      branch = local ?? (remote !== void 0 ? remote.slice("origin/".length) : containing.length > 0 ? facts.defaultBranch : null);
    }
    const mergedAs = facts.squashedInto?.[sha];
    let fate;
    if (shippedViaAncestry || cherryEquivalent.has(sha) || mergedAs) {
      fate = "shipped";
    } else {
      const hasFreshBranch = containing.some((b) => {
        const tip = facts.branchTipDates[b];
        if (!tip) return false;
        const tipMs = Date.parse(tip);
        if (!Number.isFinite(tipMs)) return false;
        return nowMs - tipMs <= freshWindowMs;
      });
      fate = hasFreshBranch ? "in_flight" : "unshipped";
    }
    out.push({ sha, branch, fate, ...mergedAs ? { mergedAs } : {} });
  }
  return out;
}

// ../parsers/src/index.ts
var SCANNERS = [
  {
    surface: "claude-code",
    revision: 4,
    scan: (opts) => scanClaudeCodeLogs(opts)
  },
  {
    surface: "copilot-cli",
    revision: 3,
    scan: (opts) => scanCopilotLogs({ ...opts, onIssue: (issue) => console.warn(`copilot-cli: quarantined conflicting copy (${issue.externalId})`) })
  },
  {
    surface: "codex",
    revision: 3,
    scan: (opts) => scanCodexLogs({ ...opts, onIssue: (issue) => console.warn(`codex: quarantined conflicting copy (${issue.externalId})`) })
  },
  {
    surface: "pi",
    revision: 1,
    requiresSurfaceCapability: true,
    scan: (opts) => scanPiLogs({ ...opts, onIssue: (issue) => console.warn(`pi: quarantined usage (${issue.reason})`) })
  },
  {
    surface: "gemini-cli",
    revision: 1,
    requiresSurfaceCapability: true,
    scan: (opts) => scanGeminiLogs({ ...opts, onIssue: (issue) => console.warn(`gemini-cli: quarantined usage (${issue.reason})`) })
  }
];

// src/config.ts
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile as readFile6, rename, rm, writeFile } from "node:fs/promises";
import { homedir as homedir6 } from "node:os";
import { join as join7 } from "node:path";

// src/update.ts
import { realpathSync } from "node:fs";

// src/version.ts
var CLI_VERSION = "0.9.0";
var WIRE_VERSION = "1";
function versionHeaders() {
  return {
    "centrail-cli-version": CLI_VERSION,
    "centrail-wire": WIRE_VERSION
  };
}

// src/update.ts
function detectChannel(script = process.argv[1] ?? "", env = process.env) {
  const p = realpath(script).replace(/\\/g, "/");
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (pluginRoot && p.startsWith(`${pluginRoot}/`) || p.endsWith("/scripts/centrail.mjs")) return "plugin";
  if (p.includes("/_npx/")) return "npx";
  if (p.includes("/installs/npm-centrail/")) return "mise";
  if (/\/(lib|npm)\/node_modules\/centrail\//.test(p) && !p.includes("/.volta/")) return "npm-global";
  return "unknown";
}
function howToUpdate(channel) {
  switch (channel) {
    case "plugin":
      return "update it in Claude Code with `/plugin marketplace update centrail`";
    case "npx":
      return "run `npx centrail@latest`";
    case "mise":
      return "run `mise upgrade npm:centrail`";
    case "npm-global":
      return "run `npm i -g centrail@latest`";
    default:
      return "update it the way you installed it (`npm i -g centrail@latest` for a global install)";
  }
}
function copyLabel(channel) {
  switch (channel) {
    case "plugin":
      return "Claude Code plugin";
    case "npx":
      return "npx";
    case "mise":
      return "mise install";
    case "npm-global":
      return "global npm install";
    default:
      return "another install";
  }
}
function updateNoticeLine(n) {
  return `centrail ${n.latest} is available (you have ${n.version}): ${howToUpdate(n.channel)}.`;
}
function outdatedLine(o) {
  const floor = o.minimum ? ` (${o.minimum} or newer)` : "";
  return `centrail ${o.version} is older than the server accepts${floor}, so syncing has stopped until it is updated: ${howToUpdate(o.channel)}.`;
}
function here(channel = detectChannel()) {
  return { version: CLI_VERSION, channel };
}
function sameInstall(rec, at) {
  return rec.version === at.version || rec.channel === at.channel;
}
function settleVersions(state, cli, at) {
  const before = JSON.stringify([state.updateNotice, state.outdated]);
  if (cli?.latest) {
    if (isOlder(at.version, cli.latest)) state.updateNotice = { ...at, latest: cli.latest };
    else if (state.updateNotice && sameInstall(state.updateNotice, at)) delete state.updateNotice;
  }
  if (cli?.minimum) {
    if (isOlder(at.version, cli.minimum)) state.outdated = { ...at, minimum: cli.minimum };
    else if (state.outdated && sameInstall(state.outdated, at)) delete state.outdated;
  }
  return JSON.stringify([state.updateNotice, state.outdated]) !== before;
}
function hookParked(state, version = CLI_VERSION) {
  return state.outdated?.version === version;
}
function stillTrue(rec, at, floor) {
  if (!rec || !sameInstall(rec, at)) return rec;
  return (floor ? isOlder(at.version, floor) : rec.version === at.version) ? rec : void 0;
}
function pluginCaughtUp(rec, pluginVersion, floor) {
  if (!rec || rec.channel !== "plugin" || !pluginVersion) return false;
  return floor ? !isOlder(pluginVersion, floor) : pluginVersion !== rec.version;
}
function liveVersionRecords(state, at, pluginVersion) {
  let outdated = stillTrue(state.outdated, at, state.outdated?.minimum);
  let notice = stillTrue(state.updateNotice, at, state.updateNotice?.latest);
  if (pluginCaughtUp(outdated, pluginVersion, outdated?.minimum)) outdated = void 0;
  if (pluginCaughtUp(notice, pluginVersion, notice?.latest)) notice = void 0;
  if (notice && outdated && sameInstall(notice, outdated)) notice = void 0;
  return { ...outdated ? { outdated } : {}, ...notice ? { notice } : {} };
}
var CliOutdatedError = class extends Error {
  constructor(outdated) {
    super(outdatedLine(outdated));
    this.outdated = outdated;
  }
};
async function minimumFrom(res) {
  const body = await res.json().catch(() => null);
  return validVersion(body?.minimum) ? body.minimum : void 0;
}
function parseCliVersions(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return void 0;
  const o = raw;
  const out = {};
  if (validVersion(o.latest)) out.latest = o.latest;
  if (validVersion(o.minimum)) out.minimum = o.minimum;
  return out.latest || out.minimum ? out : void 0;
}
function parseUpdateNotice(raw) {
  const rec = parseVersionRecord(raw);
  const latest = raw?.latest;
  return rec && validVersion(latest) ? { ...rec, latest } : void 0;
}
function parseOutdated(raw) {
  const rec = parseVersionRecord(raw);
  const minimum = raw?.minimum;
  return rec ? { ...rec, ...validVersion(minimum) ? { minimum } : {} } : void 0;
}
function parseVersionRecord(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return void 0;
  const o = raw;
  if (!validVersion(o.version)) return void 0;
  const channel = CHANNELS.includes(o.channel) ? o.channel : "unknown";
  return { version: o.version, channel };
}
var CHANNELS = ["plugin", "npx", "mise", "npm-global", "unknown"];
var SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
function validVersion(v) {
  return typeof v === "string" && SEMVER.test(v);
}
function compareVersions(a, b) {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return Math.sign(d);
  }
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const p = x[4].split(".");
  const q = y[4].split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === void 0) return -1;
    if (q[i] === void 0) return 1;
    const m = /^\d+$/.test(p[i]);
    const n = /^\d+$/.test(q[i]);
    if (m && n) {
      const d = Number(p[i]) - Number(q[i]);
      if (d !== 0) return Math.sign(d);
    } else if (m !== n) {
      return m ? -1 : 1;
    } else if (p[i] !== q[i]) {
      return p[i] < q[i] ? -1 : 1;
    }
  }
  return 0;
}
function isOlder(v, than) {
  return compareVersions(v, than) < 0;
}
function realpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// src/watermarks.ts
var SHARED_WATERMARK_SURFACES = /* @__PURE__ */ new Set(["claude-code", "copilot-cli", "codex"]);
function parseSyncState(raw) {
  const obj = isObject6(raw) ? raw : {};
  const surfaces = {};
  if (isObject6(obj.surfaces)) {
    for (const [surface, value] of Object.entries(obj.surfaces)) {
      if (typeof value === "string") surfaces[surface] = value;
    }
  }
  const scannerRevisions = {};
  if (isObject6(obj.scannerRevisions)) {
    for (const [surface, value] of Object.entries(obj.scannerRevisions)) {
      if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        scannerRevisions[surface] = value;
      }
    }
  }
  const updateNotice = parseUpdateNotice(obj.updateNotice);
  const outdated = parseOutdated(obj.outdated);
  return {
    lastSyncAt: typeof obj.lastSyncAt === "string" ? obj.lastSyncAt : null,
    surfaces,
    scannerRevisions,
    ...typeof obj.autoSyncAt === "string" ? { autoSyncAt: obj.autoSyncAt } : {},
    ...Array.isArray(obj.capabilities) ? { capabilities: obj.capabilities.filter((f) => typeof f === "string") } : {},
    ...updateNotice ? { updateNotice } : {},
    ...outdated ? { outdated } : {}
  };
}
function sinceForSurface(state, surface, scannerRevision = 1) {
  let since;
  const completedRevision = state.scannerRevisions[surface] ?? 1;
  if (completedRevision >= scannerRevision) {
    const own = state.surfaces[surface];
    if (own) since = validDate(own);
    else if (state.lastSyncAt && SHARED_WATERMARK_SURFACES.has(surface)) since = validDate(state.lastSyncAt);
  }
  for (const [key, iso] of Object.entries(state.surfaces)) {
    const revision = markRevision(key, surface);
    if (revision === void 0 || revision < scannerRevision) continue;
    const mark = validDate(iso);
    if (mark && (!since || mark > since)) since = mark;
  }
  return since;
}
function stampWatermark(state, surface, revision, at) {
  state.surfaces[surface] = at.toISOString();
  state.scannerRevisions[surface] = revision;
  state.surfaces[`${surface}@${revision}`] = at.toISOString();
}
function markRevision(key, surface) {
  if (!key.startsWith(`${surface}@`)) return void 0;
  const revision = Number(key.slice(surface.length + 1));
  return Number.isInteger(revision) && revision > 0 ? revision : void 0;
}
function validDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? void 0 : date;
}
function isObject6(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// src/config.ts
var CONFIG_DIR = process.env.CENTRAIL_CONFIG_DIR?.trim() || join7(homedir6(), ".config", "centrail");
var AUTH_PATH = join7(CONFIG_DIR, "auth.json");
var DISCONNECTED_PATH = join7(CONFIG_DIR, "auth.disconnected.json");
var STATE_PATH = join7(CONFIG_DIR, "state.json");
async function readAuth() {
  try {
    const raw = JSON.parse(await readFile6(AUTH_PATH, "utf-8"));
    if (typeof raw.baseUrl !== "string" || typeof raw.token !== "string" || typeof raw.deviceName !== "string") {
      return null;
    }
    const account = raw.account;
    return {
      baseUrl: raw.baseUrl,
      token: raw.token,
      deviceName: raw.deviceName,
      ...typeof account?.email === "string" && account.email ? { account: { email: account.email } } : {}
    };
  } catch {
    return null;
  }
}
var NODE_PATH_FILE = join7(CONFIG_DIR, "node");
async function recordNode(execPath = process.execPath, file = NODE_PATH_FILE) {
  try {
    const now = await readFile6(file, "utf-8").catch(() => "");
    if (now.trim() === execPath) return;
    await mkdir(join7(file, ".."), { recursive: true });
    await writeFile(file, `${execPath}
`);
  } catch {
  }
}
async function writeJsonAtomic(path, value, mode2) {
  await mkdir(CONFIG_DIR, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}
`, mode2 === void 0 ? {} : { mode: mode2 });
  await replaceFile(tmp, path);
}
async function replaceFile(tmp, path, platform = process.platform) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      const code = err.code;
      const held = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (platform !== "win32" || !held || attempt >= 6) {
        await rm(tmp, { force: true });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 25 * 2 ** attempt));
    }
  }
}
async function writeAuth(auth) {
  await writeJsonAtomic(AUTH_PATH, auth, 384);
  await chmod(AUTH_PATH, 384);
  await rm(DISCONNECTED_PATH, { force: true });
}
async function parkAuth(reason) {
  const auth = await readAuth();
  if (!auth) return;
  await writeJsonAtomic(DISCONNECTED_PATH, { ...auth, disconnectedAt: (/* @__PURE__ */ new Date()).toISOString(), reason }, 384);
  await rm(AUTH_PATH, { force: true });
}
async function readDisconnected() {
  try {
    const raw = JSON.parse(await readFile6(DISCONNECTED_PATH, "utf-8"));
    const reason = raw.reason === "device_revoked" || raw.reason === "unknown_token" ? raw.reason : "unauthorized";
    return {
      at: typeof raw.disconnectedAt === "string" ? raw.disconnectedAt : "",
      reason,
      baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : ""
    };
  } catch {
    return null;
  }
}
function disconnectedMessage(d) {
  const why = d.reason === "device_revoked" ? "its pairing was replaced from another machine or revoked in Settings \u2192 Devices" : d.reason === "unknown_token" ? "its pairing no longer exists, so the account may have been deleted" : "the server refused its token: the pairing was revoked or the account deleted";
  const noticed = d.at ? ` (noticed ${d.at.slice(0, 10)})` : "";
  return `This machine is no longer connected to Centrail: ${why}${noticed}. Run \`npx centrail connect\` to pair it again.`;
}
async function readState() {
  try {
    return parseSyncState(JSON.parse(await readFile6(STATE_PATH, "utf-8")));
  } catch {
    return parseSyncState(null);
  }
}
async function writeState(state) {
  await writeJsonAtomic(STATE_PATH, state);
}
async function parkOutdated(minimum) {
  const state = await readState();
  state.outdated = { ...here(), ...minimum ? { minimum } : {} };
  await writeState(state);
  return state.outdated;
}
var CONFIG_PATH = join7(CONFIG_DIR, "config.json");
var DEFAULT_CONFIG = {
  installId: null,
  mode: "all",
  allowRepos: [],
  denyRepos: [],
  surfaces: {},
  scopeDecidedAt: null,
  pendingBackfill: false,
  hideRepoNames: false,
  hideBranchNames: false
};
function parseConfig(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_CONFIG };
  const o = raw;
  const surfaces = {};
  if (o.surfaces && typeof o.surfaces === "object" && !Array.isArray(o.surfaces)) {
    for (const [k, v] of Object.entries(o.surfaces)) {
      if (typeof v === "boolean") surfaces[k] = v;
    }
  }
  return {
    installId: typeof o.installId === "string" && o.installId ? o.installId : null,
    mode: o.mode === "allow" ? "allow" : "all",
    allowRepos: stringList(o.allowRepos),
    denyRepos: stringList(o.denyRepos),
    surfaces,
    scopeDecidedAt: typeof o.scopeDecidedAt === "string" ? o.scopeDecidedAt : null,
    pendingBackfill: o.pendingBackfill === true,
    hideRepoNames: o.hideRepoNames === true,
    hideBranchNames: o.hideBranchNames === true
  };
}
function stringList(v) {
  return Array.isArray(v) ? v.filter((r) => typeof r === "string") : [];
}
async function readConfig() {
  try {
    return parseConfig(JSON.parse(await readFile6(CONFIG_PATH, "utf-8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
async function writeConfig(cfg) {
  await writeJsonAtomic(CONFIG_PATH, cfg);
}
async function updateConfig(mutate) {
  const cfg = await readConfig();
  mutate(cfg);
  await writeConfig(cfg);
  return cfg;
}
async function ensureInstallId() {
  const cfg = await readConfig();
  if (cfg.installId) return cfg.installId;
  cfg.installId = randomUUID();
  await writeConfig(cfg);
  return cfg.installId;
}
var LAST_SYNC_PATH = join7(CONFIG_DIR, "last-sync.json");
async function writeLastSync(body) {
  await writeJsonAtomic(LAST_SYNC_PATH, body, 384);
}
async function readLastSync() {
  try {
    return await readFile6(LAST_SYNC_PATH, "utf-8");
  } catch {
    return null;
  }
}

// src/browser.ts
import { spawn } from "node:child_process";
function shouldOpenBrowser(env = process.env, isTTY = process.stdout.isTTY === true, platform = process.platform) {
  if (!isTTY || env.CI || env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.WSL_DISTRO_NAME) return false;
  return true;
}
function browserCommand(url, env = process.env, platform = process.platform) {
  const chosen = env.BROWSER?.split(":")[0]?.trim();
  if (chosen) return [chosen, [url]];
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  if (env.WSL_DISTRO_NAME) return ["wslview", [url]];
  return ["xdg-open", [url]];
}
function openBrowser(url, baseUrl) {
  try {
    if (new URL(url).origin !== new URL(baseUrl).origin) return false;
    const [cmd, args] = browserCommand(url);
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// src/commands/integrations.ts
import { readFile as readFile13, stat as stat10 } from "node:fs/promises";
import { dirname as dirname8, join as join14, win32 as win324 } from "node:path";

// src/launcher.ts
import { realpathSync as realpathSync2 } from "node:fs";
import { chmod as chmod2, mkdir as mkdir2, readFile as readFile7, rm as rm2, stat as stat6, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2, join as join8 } from "node:path";
function launcherPath(dir = CONFIG_DIR, platform = process.platform) {
  return join8(dir, "bin", platform === "win32" ? "centrail-hook.cmd" : "centrail-hook");
}
function stableScript(script, env = process.env) {
  const channel = detectChannel(script, env);
  if (channel !== "mise" && channel !== "npm-global") return null;
  const real = safeRealpath(script);
  if (real.replace(/\\/g, "/").includes("/_npx/")) return null;
  return stableInstallPath(real);
}
function launcherTarget(script = process.argv[1] ?? "", node = process.execPath, previous = null, env = process.env) {
  const stableNode = stableInstallPath(node);
  return {
    // A copy that is not stable (npx, a checkout) keeps the stable install
    // an earlier setup recorded, so running setup from npx never downgrades.
    script: stableScript(script, env) ?? previous,
    node: stableNode.replace(/\\/g, "/").includes("/_npx/") ? null : stableNode,
    major: CLI_VERSION.split(".")[0]
  };
}
var NODE_DISCOVERY_SH = `use "$(command -v node)"
cfg="\${CENTRAIL_CONFIG_DIR:-\${HOME:-}/.config/centrail}"
if [ -r "$cfg/node" ]; then
  read -r recorded < "$cfg/node"
  use "\${recorded:-}"
fi
for n in /opt/homebrew/bin/node /usr/local/bin/node \\
  "\${HOME:-}/.volta/bin/node" "\${HOME:-}/.local/share/mise/shims/node" "\${HOME:-}/.asdf/shims/node" \\
  "\${HOME:-}/.local/share/fnm/aliases/default/bin/node" "\${HOME:-}/Library/Application Support/fnm/aliases/default/bin/node"; do
  use "$n"
done
for n in "\${NVM_DIR:-\${HOME:-}/.nvm}"/versions/node/*/bin/node; do last="$n"; done
use "\${last:-}"
`;
var MISSING = "centrail: no centrail CLI or Node.js found for this hook; run `npx centrail setup` once in a terminal";
function launcherScript(target, platform = process.platform) {
  return platform === "win32" ? windowsLauncher(target) : posixLauncher(target);
}
function posixLauncher(t) {
  return `#!/bin/sh
# centrail-hook: written by \`centrail setup\`, rewritten by each setup and
# upgrade; do not edit. Agent hooks run this fixed path, so their entries
# never change between releases. Finds a Node as the Claude Code plugin's
# hook.sh does, then runs the first centrail that exists: the install that
# ran setup, \`centrail\` on PATH, or npx. Arguments and stdin pass through.
script=${shQuote(t.script ?? "")}
pinned=${shQuote(t.node ?? "")}
node=
use() { [ -z "$node" ] && [ -n "$1" ] && [ -x "$1" ] && node="$1"; return 0; }
${NODE_DISCOVERY_SH}use "$pinned"
if [ -n "$node" ]; then
  PATH="\${node%/*}\${PATH:+:$PATH}"
  export PATH
  [ -n "$script" ] && [ -f "$script" ] && exec "$node" "$script" "$@"
fi
cli="$(command -v centrail)"
[ -n "$cli" ] && exec "$cli" "$@"
npx="$(command -v npx)"
[ -n "$npx" ] && exec "$npx" -y centrail@${t.major} "$@"
echo "${MISSING.replace(/`/g, "\\`")}" >&2
exit 1
`;
}
function windowsLauncher(t) {
  const lines = [
    "@echo off",
    "rem centrail-hook.cmd: written by `centrail setup`, rewritten by each setup and upgrade; do not edit.",
    "rem Runs the install that ran setup, else centrail on PATH, else npx. Arguments and stdin pass through.",
    "setlocal",
    `set "script=${cmdValue(t.script ?? "")}"`,
    `set "pinned=${cmdValue(t.node ?? "")}"`,
    'set "node="',
    'for %%I in (node.exe) do set "node=%%~$PATH:I"',
    'set "cfg=%CENTRAIL_CONFIG_DIR%"',
    'if not defined cfg set "cfg=%USERPROFILE%\\.config\\centrail"',
    'if not defined node if exist "%cfg%\\node" set /p node=<"%cfg%\\node"',
    'if defined node if not exist "%node%" set "node="',
    'if not defined node if exist "%pinned%" set "node=%pinned%"',
    'if not defined node if exist "%ProgramFiles%\\nodejs\\node.exe" set "node=%ProgramFiles%\\nodejs\\node.exe"',
    'if not defined node if exist "%LOCALAPPDATA%\\Volta\\bin\\node.exe" set "node=%LOCALAPPDATA%\\Volta\\bin\\node.exe"',
    'if defined node for %%D in ("%node%") do set "PATH=%%~dpD;%PATH%"',
    'if defined node if exist "%script%" goto run_script',
    'set "cli="',
    'for %%I in (centrail.cmd) do set "cli=%%~$PATH:I"',
    "if defined cli goto run_cli",
    'set "npx="',
    'for %%I in (npx.cmd) do set "npx=%%~$PATH:I"',
    "if defined npx goto run_npx",
    `>&2 echo ${MISSING.replace(/`/g, "")}`,
    "exit /b 1",
    ":run_script",
    '"%node%" "%script%" %*',
    "exit /b %ERRORLEVEL%",
    ":run_cli",
    'call "%cli%" %*',
    "exit /b %ERRORLEVEL%",
    ":run_npx",
    `call "%npx%" -y centrail@${t.major} %*`,
    "exit /b %ERRORLEVEL%"
  ];
  return `${lines.join("\r\n")}\r
`;
}
function launcherScriptPath(content) {
  return launcherValue(content, "script");
}
function launcherValue(content, name) {
  const posix = new RegExp(`^${name}='((?:[^']|'\\\\'')*)'$`, "m").exec(content);
  if (posix) return posix[1].replace(/'\\''/g, "'") || null;
  const win = new RegExp(`^set "${name}=([^"\\r\\n]*)"\\r?$`, "m").exec(content);
  return win ? win[1] || null : null;
}
async function readLauncher(path = launcherPath()) {
  try {
    return await readFile7(path, "utf-8");
  } catch {
    return null;
  }
}
async function writeLauncher(content, path = launcherPath()) {
  if (await readLauncher(path) === content && await isExecutable(path)) return false;
  await mkdir2(dirname2(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile2(tmp, content, { mode: 493 });
  await chmod2(tmp, 493);
  await replaceFile(tmp, path);
  return true;
}
async function removeLauncher(path = launcherPath()) {
  if (await readLauncher(path) === null) return false;
  await rm2(path, { force: true });
  return true;
}
async function isExecutable(path, platform = process.platform) {
  try {
    const s = await stat6(path);
    return s.isFile() && (platform === "win32" || (s.mode & 73) !== 0);
  } catch {
    return false;
  }
}
function stableInstallPath(p) {
  const m = /^(.*[\\/]installs[\\/][^\\/]+[\\/])([^\\/]+)([\\/].*)$/.exec(p);
  if (!m) return p;
  const [, base, version, rest2] = m;
  const target = safeRealpath(p);
  for (const alias of ["latest", version.split(".")[0]]) {
    if (alias === version) return p;
    const candidate = `${base}${alias}${rest2}`;
    if (safeRealpath(candidate) === target && candidate !== target) return candidate;
  }
  return p;
}
function safeRealpath(p) {
  try {
    return realpathSync2(p);
  } catch {
    return p;
  }
}
function shQuote(s) {
  if (/[\n\r]/.test(s)) throw new Error("Cannot write a launcher with a newline in a path.");
  return `'${s.replace(/'/g, "'\\''")}'`;
}
function cmdValue(s) {
  if (/[\n\r"%]/.test(s)) throw new Error("Cannot write a Windows launcher with quotes, percent signs or newlines in a path.");
  return s;
}

// src/commands/agent-hooks.ts
import { homedir as homedir7 } from "node:os";
import { mkdir as mkdir4, readFile as readFile9, rm as rm3, stat as stat7, writeFile as writeFile4 } from "node:fs/promises";
import { dirname as dirname4, isAbsolute as isAbsolute3, join as join10, win32 as win322 } from "node:path";

// src/home-overrides.ts
var homeOverrides = {};

// src/commands/hooks-install.ts
import { constants } from "node:fs";
import { copyFile, mkdir as mkdir3, readFile as readFile8, writeFile as writeFile3 } from "node:fs/promises";
import { dirname as dirname3, isAbsolute as isAbsolute2, join as join9, win32 } from "node:path";
var HOOK_MARK = "hook stop";
function claudeSettingsPath() {
  return join9(claudeConfigDirs()[0], "settings.json");
}
function codexHooksPath() {
  return join9(codexHomeDir(), "hooks.json");
}
var HOOK_SURFACES = ["claude-code", "codex", "gemini-cli", "copilot-cli", "pi", "cursor", "opencode"];
function launcherCommand(launcher, surface, platform = process.platform, opts = {}) {
  const call = opts.powershell && platform === "win32" ? "& " : "";
  return `${call}${quote(launcher, platform)} ${HOOK_MARK} --centrail-hook${surface === "claude-code" ? "" : ` --surface ${surface}`}`;
}
function installStopHook(settings, command2, event = "Stop", handler = { timeout: 10 }) {
  const hooks = isObject7(settings.hooks) ? { ...settings.hooks } : {};
  const cleaned = uninstallStopHook(settings, event);
  const kept = Array.isArray(cleaned.hooks?.[event]) ? [...cleaned.hooks[event]] : [];
  kept.push({ hooks: [{ ...handler.name ? { name: handler.name } : {}, type: "command", command: command2, ...omit(handler, "name") }] });
  return { ...settings, hooks: { ...hooks, [event]: kept } };
}
function uninstallStopHook(settings, event = "Stop") {
  if (!isObject7(settings.hooks) || !Array.isArray(settings.hooks[event])) return settings;
  const kept = settings.hooks[event].flatMap((g) => {
    if (!isObject7(g) || !Array.isArray(g.hooks)) return [g];
    const handlers = g.hooks.filter((h) => !isObject7(h) || h.type !== "command" || typeof h.command !== "string" || !isCentrailCommand(h.command));
    if (handlers.length === g.hooks.length) return [g];
    return handlers.length ? [{ ...g, hooks: handlers }] : [];
  });
  const hooks = { ...settings.hooks };
  if (kept.length > 0) hooks[event] = kept;
  else delete hooks[event];
  const out = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}
function groupCommands(settings, event = "Stop") {
  const groups = Array.isArray(settings.hooks?.[event]) ? settings.hooks[event] : [];
  const out = [];
  for (const g of groups) {
    if (!isObject7(g) || !Array.isArray(g.hooks)) continue;
    for (const h of g.hooks) if (isObject7(h) && h.type === "command" && typeof h.command === "string") out.push(h.command);
  }
  return out;
}
function omit(o, key) {
  const { [key]: _, ...rest2 } = o;
  return rest2;
}
function commandWords(command2) {
  const words = [];
  if (/^& ["']/.test(command2)) command2 = command2.slice(2);
  const windows = /"(?:[a-z]:\\|\\\\)/i.test(command2);
  let word = "", quoted = "", started = false;
  for (let i = 0; i < command2.length; i++) {
    const char = command2[i];
    if (/[\n\r]/.test(char)) return null;
    if (quoted) {
      if (char === quoted) quoted = "";
      else if (!windows && quoted === '"' && char === "\\" && /[\\"$`]/.test(command2[i + 1] ?? "")) word += command2[++i];
      else word += char;
    } else if (char === '"' || char === "'") {
      quoted = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      if (/[;&|<>$`]/.test(char)) return null;
      word += char;
      started = true;
    }
  }
  if (quoted) return null;
  if (started) words.push(word);
  return words;
}
function isCentrailCommand(command2) {
  const words = commandWords(command2);
  if (!words) return false;
  const normal = words.map((w) => w.replaceAll("\\", "/"));
  const base = (s) => s.split("/").pop() ?? "";
  const cli = (s) => /(?:^|\/)centrail(?:\.cmd|\.exe|@[^/]*)?$/.test(s);
  const bundle = (s) => /(?:^|\/)centrail(?:[-@][^/]*)?\/(?:.*\/)?(?:index\.js|centrail\.mjs)$/.test(s) || /\/scripts\/centrail\.mjs$/.test(s);
  const stopArgs = (args) => {
    const rest2 = args.join(" ");
    if (!rest2.startsWith(HOOK_MARK)) return false;
    const tail = rest2.slice(HOOK_MARK.length).replace(/^ --centrail-hook/, "");
    return tail === "" || HOOK_SURFACES.some((s) => s !== "claude-code" && tail === ` --surface ${s}`);
  };
  const absolute2 = (s) => isAbsolute2(s) || win32.isAbsolute(s);
  if (absolute2(words[0] ?? "") && /^centrail-hook(?:\.cmd)?$/.test(base(normal[0] ?? "")) && words.includes("--centrail-hook") && stopArgs(words.slice(1))) return true;
  if (words.slice(2).includes("--centrail-hook") && stopArgs(words.slice(2)) && absolute2(words[0] ?? "") && absolute2(words[1] ?? "")) return true;
  if (cli(normal[0] ?? "") && stopArgs(normal.slice(1))) return true;
  if (/^node(?:\.exe)?$/.test(base(normal[0] ?? "")) && stopArgs(normal.slice(2)) && (words.includes("--centrail-hook") || bundle(normal[1] ?? ""))) return true;
  if (/^npx(?:\.cmd)?$/.test(base(normal[0] ?? ""))) {
    const args = normal.slice(1);
    if (args[0] === "-y" || args[0] === "--yes") args.shift();
    return cli(args[0] ?? "") && stopArgs(args.slice(1));
  }
  return normal.length === 2 && /^(?:sh|bash)(?:\.exe)?$/.test(base(normal[0])) && /\/centrail\/(?:[^/]+\/)?scripts\/hook\.sh$/.test(normal[1]);
}
var PLUGIN_ID = "centrail@centrail";
function pluginEnabled(settings) {
  return isObject7(settings.enabledPlugins) && settings.enabledPlugins[PLUGIN_ID] === true;
}
async function readSettingsFile(path) {
  let raw;
  try {
    raw = await readFile8(path, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return { settings: {}, indent: "  " };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Cannot parse ${path}: ${err.message}`);
  }
  if (!isObject7(parsed)) throw new Error(`Cannot parse ${path}: not a JSON object`);
  return { settings: parsed, indent: /^([ \t]+)"/m.exec(raw)?.[1] ?? "  " };
}
async function writeSettingsFile(path, settings, indent = "  ") {
  await mkdir3(dirname3(path), { recursive: true });
  await backUpSettings(path);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile3(tmp, `${JSON.stringify(settings, null, indent)}
`);
  await replaceFile(tmp, path);
}
async function backUpSettings(path) {
  try {
    await copyFile(path, `${path}.centrail-backup`, constants.COPYFILE_EXCL);
  } catch (err) {
    const code = err.code;
    if (code !== "EEXIST" && code !== "ENOENT") throw err;
  }
}
function quote(s, platform) {
  if (/[\n\r]/.test(s)) throw new Error("Cannot install a hook with a newline in an executable path.");
  if (platform === "win32") {
    if (/["%]/.test(s)) throw new Error("Cannot install a Windows hook with quotes or percent expansion in an executable path.");
    return `"${s}"`;
  }
  return `"${s.replace(/[\\"$`]/g, "\\$&")}"`;
}
function isObject7(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// src/commands/agent-hooks.ts
function defaultHome(agent, env = process.env) {
  const forTests = homeOverrides[agent];
  if (forTests) return forTests;
  if (agent === "codex") return codexHomeDir();
  if (agent === "gemini-cli") return join10(env.GEMINI_CLI_HOME || homedir7(), ".gemini");
  if (agent === "copilot-cli") return env.COPILOT_HOME || join10(homedir7(), ".copilot");
  if (agent === "cursor") return join10(homedir7(), ".cursor");
  if (agent === "opencode") return opencodeConfigDir(env);
  return dirname4(piSessionsDir());
}
function opencodeConfigDir(env = process.env) {
  return join10(env.XDG_CONFIG_HOME || join10(homedir7(), ".config"), "opencode");
}
async function classifyCommand(command2, expected, platform) {
  const words = commandWords(command2) ?? [];
  const launcherForm = /(?:^|[\\/])centrail-hook(?:\.cmd)?$/.test(words[0] ?? "");
  const absolute2 = words.slice(0, 2).filter((w) => isAbsolute3(w) || win322.isAbsolute(w));
  const pinned = !launcherForm && absolute2.length === 2;
  const resolves = launcherForm ? await isExecutable(words[0], platform) : pinned && (await Promise.all(absolute2.map(exists))).every(Boolean);
  return { form: launcherForm ? "launcher" : pinned ? "pinned" : "other", current: command2 === expected, resolves };
}
async function readJson(file) {
  try {
    return (await readSettingsFile(file)).settings;
  } catch {
    return null;
  }
}
function groupHook(o) {
  const command2 = (launcher, platform) => launcherCommand(launcher, o.agent, platform, { powershell: o.powershell });
  return {
    agent: o.agent,
    label: o.label,
    bin: o.bin,
    how: o.how,
    usage: true,
    fileName: o.fileName,
    file: (home) => join10(home, o.fileName),
    async read(file, launcher, platform) {
      const settings = await readJson(file);
      if (!settings) return { readable: false, hooks: [] };
      const expected = command2(launcher, platform);
      const hooks = await Promise.all(groupCommands(settings, o.event).filter(isCentrailCommand).map((c) => classifyCommand(c, expected, platform)));
      return { readable: true, hooks };
    },
    async install(file, launcher, platform) {
      const { settings, indent } = await readSettingsFile(file);
      await writeSettingsFile(file, installStopHook(settings, command2(launcher, platform), o.event, o.handler), indent);
    },
    async uninstall(file) {
      const { settings, indent } = await readSettingsFile(file);
      await writeSettingsFile(file, uninstallStopHook(settings, o.event), indent);
    }
  };
}
function flatHook(o) {
  const owns = (e) => isObject8(e) && o.keys.some((k) => typeof e[k] === "string" && isCentrailCommand(e[k]));
  const entries = (settings) => Array.isArray(settings.hooks?.[o.event]) ? settings.hooks[o.event] : [];
  const without = (settings) => {
    const hooks = isObject8(settings.hooks) ? { ...settings.hooks } : {};
    const kept = entries(settings).filter((e) => !owns(e));
    if (kept.length) hooks[o.event] = kept;
    else delete hooks[o.event];
    return { ...settings, hooks };
  };
  const command2 = (launcher, platform) => launcherCommand(launcher, o.agent, platform, { powershell: true });
  return {
    agent: o.agent,
    label: o.label,
    bin: o.bin,
    how: o.how,
    usage: o.usage ?? true,
    fileName: o.fileName,
    file: (home) => join10(home, o.fileName),
    async read(file, launcher, platform) {
      const settings = await readJson(file);
      if (!settings) return { readable: false, hooks: [] };
      const commands = entries(settings).flatMap((e) => isObject8(e) ? o.keys.map((k) => e[k]).filter((c) => typeof c === "string") : []);
      const expected = command2(launcher, platform);
      return { readable: true, hooks: await Promise.all(commands.filter(isCentrailCommand).map((c) => classifyCommand(c, expected, platform))) };
    },
    async install(file, launcher, platform) {
      const { settings, indent } = await readSettingsFile(file);
      const next = without(settings);
      const entry = { type: "command", [o.key(platform)]: command2(launcher, platform), ...o.extra };
      await writeSettingsFile(file, { version: 1, ...next, hooks: { ...next.hooks, [o.event]: [...entries(next), entry] } }, indent);
    },
    async uninstall(file) {
      const { settings, indent } = await readSettingsFile(file);
      const next = without(settings);
      const rest2 = Object.keys(next).filter((k) => k !== "version" && !(k === "hooks" && Object.keys(next.hooks ?? {}).length === 0));
      if (rest2.length === 0) await rm3(file, { force: true });
      else await writeSettingsFile(file, next, indent);
    }
  };
}
var spawnLauncher = (detached) => `function run(input) {
  try {
    const options = { detached: ${detached}, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] };
    // A .cmd runs only through a shell on Windows.
    const child = process.platform === "win32"
      ? spawn(\`"\${launcher}"\`, args, { ...options, shell: true })
      : spawn(launcher, args, options);
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
    child.unref();
  } catch {
    // never break the agent over a sync
  }
}`;
function moduleHeader(mark, agent, launcher, what, detached = "true") {
  return `// ${mark}: written by \`centrail setup\`, rewritten by each setup,
// removed by \`centrail uninstall\`; do not edit. ${what}
import { spawn } from "node:child_process";

const launcher = ${JSON.stringify(launcher)};
const args = ["hook", "stop", "--centrail-hook", "--surface", "${agent}"];

${spawnLauncher(detached)}
`;
}
var PI_EXTENSION_MARK = "centrail-pi-extension";
function piExtension(launcher) {
  return `${moduleHeader(PI_EXTENSION_MARK, "pi", launcher, `After each agent run it starts
// centrail's stable launcher (--centrail-hook --surface pi) in the background
// with the session id and folder on stdin. Pi does not wait for it.`)}
export default function centrail(pi) {
  pi.on("agent_end", (_event, ctx) => {
    try {
      run({ hook_event_name: "agent_end", session_id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd });
    } catch {
      // never break the agent over a sync
    }
  });
}
`;
}
function moduleLauncher(content, mark) {
  if (!content.split("\n", 1)[0].includes(mark)) return null;
  const m = /^const launcher = ("(?:[^"\\]|\\.)*");$/m.exec(content);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}
function moduleHook(o) {
  return {
    agent: o.agent,
    label: o.label,
    bin: o.bin,
    how: o.how,
    usage: o.usage ?? true,
    module: true,
    fileName: o.fileName,
    file: (home) => join10(home, o.fileName),
    async read(file, launcher, platform) {
      let content;
      try {
        content = await readFile9(file, "utf-8");
      } catch {
        return { readable: true, hooks: [] };
      }
      const runs = moduleLauncher(content, o.mark);
      if (runs === null) return { readable: false, hooks: [] };
      return { readable: true, hooks: [{ form: "launcher", current: content === o.render(launcher), resolves: await isExecutable(runs, platform) }] };
    },
    async install(file, launcher) {
      await mkdir4(dirname4(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile4(tmp, o.render(launcher));
      await replaceFile(tmp, file);
    },
    async uninstall(file) {
      const content = await readFile9(file, "utf-8").catch(() => null);
      if (content !== null && moduleLauncher(content, o.mark) !== null) await rm3(file, { force: true });
    }
  };
}
var OPENCODE_PLUGIN_MARK = "centrail-opencode-plugin";
function opencodePlugin(launcher) {
  return `${moduleHeader(
    OPENCODE_PLUGIN_MARK,
    "opencode",
    launcher,
    `When a session goes idle (a prompt's
// run ended) it starts centrail's stable launcher (--centrail-hook --surface
// opencode) in the background with the session id and folder on stdin.
// OpenCode does not wait for it.`,
    'process.platform !== "win32"'
  )}
const recent = new Map();

export const CentrailPlugin = async ({ client, directory }) => ({
  event: async ({ event }) => {
    try {
      const idle = event.type === "session.idle" || (event.type === "session.status" && event.properties?.status?.type === "idle");
      const id = event.properties?.sessionID;
      if (!idle || typeof id !== "string") return;
      const now = Date.now();
      if (now - (recent.get(id) ?? 0) < 2000) return; // session.status and session.idle, together
      recent.set(id, now);
      let session;
      try {
        session = (await client.session.get({ path: { id } })).data;
      } catch {
        // an older server: place it by the plugin's folder
      }
      if (session?.parentID) return;
      run({ hook_event_name: "session.idle", session_id: id, cwd: session?.directory || directory });
    } catch {
      // never break the agent over a sync
    }
  },
});
`;
}
var AGENT_HOOKS = [
  groupHook({ agent: "codex", label: "Codex", bin: "codex", how: "Stop hook", fileName: "hooks.json", event: "Stop", handler: { timeout: 10 }, powershell: false }),
  groupHook({
    agent: "gemini-cli",
    label: "Gemini CLI",
    bin: "gemini",
    how: "AfterAgent hook",
    fileName: "settings.json",
    event: "AfterAgent",
    handler: { name: "centrail", timeout: 1e4 },
    // Gemini CLI runs hook commands through PowerShell on Windows.
    powershell: true
  }),
  flatHook({
    agent: "copilot-cli",
    label: "Copilot CLI",
    bin: "copilot",
    how: "agentStop hook",
    fileName: join10("hooks", "centrail.json"),
    event: "agentStop",
    key: (platform) => platform === "win32" ? "powershell" : "bash",
    keys: ["bash", "powershell", "command"],
    extra: { timeoutSec: 10 }
  }),
  moduleHook({ agent: "pi", label: "Pi", bin: "pi", how: "extension", fileName: join10("extensions", "centrail.js"), mark: PI_EXTENSION_MARK, render: piExtension }),
  // No usage scanner reads Cursor's or OpenCode's logs yet: their entries
  // record repo identity only, and setup adds them only when named.
  flatHook({
    agent: "cursor",
    label: "Cursor",
    bin: "cursor",
    how: "stop hook",
    fileName: "hooks.json",
    event: "stop",
    // Cursor runs hook commands through PowerShell on Windows.
    key: () => "command",
    keys: ["command"],
    extra: { timeout: 10 },
    usage: false
  }),
  moduleHook({ agent: "opencode", label: "OpenCode", bin: "opencode", how: "plugin", fileName: join10("plugins", "centrail.js"), mark: OPENCODE_PLUGIN_MARK, render: opencodePlugin, usage: false })
];
async function exists(p) {
  try {
    await stat7(p);
    return true;
  } catch {
    return false;
  }
}
function isObject8(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// src/commands/plugin-setup.ts
import { execFile } from "node:child_process";
import { constants as constants2 } from "node:fs";
import { access } from "node:fs/promises";
import { basename as basename3, delimiter, join as join11 } from "node:path";
import { createInterface } from "node:readline/promises";
var MARKETPLACE = "centrail";
var MARKETPLACE_REPO = "braydenyancy/centrail-cli";
var RELEASE_REF = "release";
var PLUGIN_STEPS = `
  Claude Code can run centrail after every turn through its plugin, kept current by Claude Code:
    claude plugin marketplace add ${MARKETPLACE_REPO}#${RELEASE_REF}
    claude plugin install ${PLUGIN_ID}
  then turn on its updates: /plugin \u2192 Marketplaces \u2192 ${MARKETPLACE} \u2192 Enable auto-update.`;
async function setUpPlugin(claude, path) {
  let file = await readOrSay(path);
  if (!file) return false;
  await backUpSettings(path);
  const entry = marketplaceEntry(file.settings);
  if (entry && !isReleaseSource(entry.source)) {
    await writeSettingsFile(path, withMarketplace(file.settings, { ...entry, source: RELEASE_SOURCE }), file.indent);
  }
  console.log("  Setting up the Claude Code plugin\u2026");
  for (const args of [
    ["plugin", "marketplace", "add", `${MARKETPLACE_REPO}#${RELEASE_REF}`, "--scope", "user"],
    ["plugin", "install", PLUGIN_ID, "--scope", "user"]
  ]) {
    const r = await claude(args);
    if (r.code !== 0) {
      const why = r.output.trim().split("\n").filter(Boolean).pop() ?? `exit ${r.code}`;
      console.log(`  \u2717 \`claude ${args.join(" ")}\` failed: ${why}`);
      console.log("  Try again with `centrail setup`, or by hand:");
      console.log(PLUGIN_STEPS);
      return false;
    }
  }
  file = await readOrSay(path);
  if (!file) return false;
  const withUpdates = withMarketplace(file.settings, { ...marketplaceEntry(file.settings) ?? { source: RELEASE_SOURCE }, autoUpdate: true });
  const next = uninstallStopHook(withUpdates);
  const removedHook = JSON.stringify(next) !== JSON.stringify(withUpdates);
  await writeSettingsFile(path, next, file.indent);
  console.log("  \u2713 Claude Code plugin installed. Claude Code updates it after each release (from its next launch);");
  console.log(`    to stop that: /plugin \u2192 Marketplaces \u2192 ${MARKETPLACE} \u2192 Disable auto-update.`);
  if (removedHook) console.log("  \u2713 Removed the standalone centrail Stop hook: the plugin's hook replaces it.");
  console.log("  Claude Code sessions already open: run /reload-plugins in each, or restart them, so their turns are recorded.");
  return true;
}
var RELEASE_SOURCE = { source: "github", repo: MARKETPLACE_REPO, ref: RELEASE_REF };
function marketplaceEntry(settings) {
  const all = settings.extraKnownMarketplaces;
  const entry = isObject9(all) ? all[MARKETPLACE] : void 0;
  return isObject9(entry) ? entry : void 0;
}
function withMarketplace(settings, entry) {
  const all = isObject9(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {};
  return { ...settings, extraKnownMarketplaces: { ...all, [MARKETPLACE]: entry } };
}
function isReleaseSource(source) {
  return isObject9(source) && source.source === "github" && source.repo === MARKETPLACE_REPO && source.ref === RELEASE_REF;
}
async function readOrSay(path) {
  try {
    return await readSettingsFile(path);
  } catch (err) {
    console.log(`  ${err.message}. Left it as it is; to set the plugin up by hand:`);
    console.log(PLUGIN_STEPS);
    return null;
  }
}
async function findExecutable(name, env = process.env, platform = process.platform) {
  const win = platform === "win32";
  const exts = win ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(win ? ";" : delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const bin = join11(dir, `${name}${ext}`);
      try {
        await access(bin, win ? constants2.F_OK : constants2.X_OK);
        return bin;
      } catch {
      }
    }
  }
  return null;
}
function runnerFor(bin, platform = process.platform) {
  const win = platform === "win32";
  return (args) => new Promise((resolve) => {
    execFile(win ? basename3(bin).replace(/\.(?:cmd|exe|bat)$/i, "") : bin, args, { shell: win, timeout: 18e4, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? typeof err.code === "number" ? err.code : 1 : 0;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });
}
async function askLine(prompt) {
  process.stdout.write(prompt);
  if (process.stdin.readableEnded) {
    process.stdout.write("\n");
    return null;
  }
  const rl = createInterface({ input: process.stdin });
  try {
    const next = await rl[Symbol.asyncIterator]().next();
    if (next.done) process.stdout.write("\n");
    return next.done ? null : String(next.value);
  } finally {
    rl.close();
  }
}
function isObject9(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// src/commands/scope.ts
import { createInterface as createInterface2 } from "node:readline/promises";

// src/resolver.ts
import { stat as stat9 } from "node:fs/promises";

// src/git.ts
import { execFile as execFile2, spawn as spawn2 } from "node:child_process";
import { createHash as createHash3 } from "node:crypto";
import { readFile as readFile10, stat as stat8 } from "node:fs/promises";
import { basename as basename4, dirname as dirname5, join as join12, win32 as win323 } from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile2);
var GIT_REDIRECT_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE"
];
function gitEnv(base = process.env) {
  const env = { ...base };
  for (const key of GIT_REDIRECT_VARS) delete env[key];
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}
function exec(cmd, args, opts = {}) {
  const result = execFileAsync(cmd, args, { ...opts, env: gitEnv(), windowsHide: true });
  return new Promise((resolve, reject) => {
    for (const stream of [result.child?.stdin, result.child?.stdout, result.child?.stderr]) {
      stream?.on("error", reject);
    }
    result.then(resolve, reject);
  });
}
function gitExec(args, opts = {}) {
  return exec("git", args, opts);
}
async function resolveRepoRoot(cwd) {
  try {
    const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    const root = stdout.trim();
    return root ? nativePath(root) : null;
  } catch {
    return null;
  }
}
function nativePath(p, platform = process.platform) {
  if (platform !== "win32") return p;
  const n = win323.normalize(p);
  return /^[a-z]:/.test(n) ? n[0].toUpperCase() + n.slice(1) : n;
}
function isWithin(path, root, platform = process.platform) {
  const [p, r] = platform === "win32" ? [winKey(path), winKey(root)] : [path, root];
  const sep = platform === "win32" ? "\\" : "/";
  return p === r || p.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}
function samePath(a, b, platform = process.platform) {
  return platform === "win32" ? winKey(a) === winKey(b) : a === b;
}
function winKey(p) {
  return win323.normalize(p).toLowerCase();
}
async function nearestDirectory(path) {
  let dir = path;
  for (; ; ) {
    try {
      if ((await stat8(dir)).isDirectory()) return dir;
    } catch {
    }
    const parent = dirname5(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function deepestRoot(roots, path) {
  let best = null;
  for (const r of roots) if (isWithin(path, r) && (!best || r.length > best.length)) best = r;
  return best;
}
async function nestedCheckout(root, dir) {
  for (let d = dir; !samePath(d, root) && isWithin(d, root); d = dirname5(d)) {
    try {
      await stat8(join12(d, ".git"));
      return true;
    } catch {
    }
  }
  return false;
}
async function readMainCheckout(repoRoot) {
  try {
    const { stdout } = await exec("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const common = stdout.trim() ? nativePath(stdout.trim()) : "";
    if (!common || basename4(common) !== ".git") return null;
    const main = dirname5(common);
    return samePath(main, repoRoot) ? null : main;
  } catch {
    return null;
  }
}
async function readCommonDir(repoRoot) {
  try {
    const { stdout } = await exec("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return stdout.trim() ? nativePath(stdout.trim()) : null;
  } catch {
    return null;
  }
}
async function readRefsDigest(repoRoot, commonDir) {
  try {
    const [refs, worktrees] = await Promise.all([
      exec("git", ["-C", repoRoot, "for-each-ref", "--format=%(objectname) %(refname)"], { maxBuffer: FACT_BUFFER }),
      exec("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], { maxBuffer: FACT_BUFFER })
    ]);
    const heads = worktrees.stdout.split("\n").filter((l) => l.startsWith("HEAD ") || l.startsWith("detached") || l.startsWith("branch "));
    const shallow = await readFile10(join12(commonDir, "shallow"), "utf-8").catch(() => "");
    return createHash3("sha256").update(refs.stdout).update("\0").update(heads.join("\n")).update("\0").update(shallow).digest("hex");
  } catch {
    return null;
  }
}
function revRange(ref) {
  return ref === "--all" ? ["--exclude=refs/stash", "--exclude=refs/notes/*", "--all"] : [ref];
}
async function readRepoCommits(repoRoot, ref = "HEAD") {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", repoRoot, "log", ...revRange(ref), "--numstat", "--pretty=format:%x1e%H%x1f%cI", "--"],
      { maxBuffer: 64 * 1024 * 1024 }
    );
    return parseGitLogNumstat(stdout);
  } catch {
    return [];
  }
}
var FACT_BUFFER = 16 * 1024 * 1024;
var RECENT_SHA_CAP = 2e3;
async function resolveDefaultBranch(repoRoot) {
  const candidates = [];
  try {
    const { stdout } = await exec("git", [
      "-C",
      repoRoot,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD"
    ]);
    const short = stdout.trim();
    if (short) candidates.push(short.replace(/^origin\//, ""));
  } catch {
  }
  candidates.push("main", "master");
  try {
    const { stdout } = await exec("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
    const current = stdout.trim();
    if (current && current !== "HEAD") candidates.push(current);
  } catch {
  }
  for (const candidate of candidates) {
    try {
      await exec("git", [
        "-C",
        repoRoot,
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${candidate}`
      ]);
      return candidate;
    } catch {
    }
  }
  return null;
}
async function resolveAncestryRef(repoRoot, defaultBranch) {
  const remote = `refs/remotes/origin/${defaultBranch}`;
  try {
    await exec("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", remote]);
    return remote;
  } catch {
    return `refs/heads/${defaultBranch}`;
  }
}
var SQUASH_CANDIDATE_CAP = 200;
var SQUASH_PREFIX_CAP = 50;
async function branchPrefixes(repoRoot, defaultRef, tipRef) {
  try {
    const mergeBase = async (ref) => (await exec("git", ["-C", repoRoot, "merge-base", defaultRef, ref])).stdout.trim();
    const base = await mergeBase(tipRef);
    if (!base) return [];
    const { stdout } = await exec(
      "git",
      ["-C", repoRoot, "rev-list", "--reverse", `--max-count=${SQUASH_PREFIX_CAP}`, "--format=%H%x1f%cI%x1f%P", `${base}..${tipRef}`],
      { maxBuffer: FACT_BUFFER }
    );
    const range = stdout.split("\n").filter((l) => l.includes("")).map((l) => l.split("").map((x) => x.trim())).map(([sha, at, parents]) => ({ sha, at, merge: parents.split(" ").length > 1 }));
    if (!range.some((c) => c.merge)) return range.map(({ sha, at }) => ({ sha, at, base }));
    const { stdout: pathOut } = await exec(
      "git",
      ["-C", repoRoot, "rev-list", "--ancestry-path", `${base}..${tipRef}`],
      { maxBuffer: FACT_BUFFER }
    );
    const onPath = new Set(pathOut.split("\n").map((l) => l.trim()).filter(Boolean));
    const out = [];
    for (const { sha, at } of range) {
      const own = onPath.has(sha) ? base : await mergeBase(sha);
      if (own) out.push({ sha, at, base: own });
    }
    return out;
  } catch {
    return [];
  }
}
function patchIds(repoRoot, commits) {
  if (commits.length === 0) return Promise.resolve({});
  return new Promise((resolve) => {
    const opts = { env: { ...gitEnv(), GIT_ATTR_NOSYSTEM: "1" }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true };
    const diff = spawn2(
      "git",
      ["-C", repoRoot, "-c", "core.quotePath=true", "-c", "core.attributesFile=/dev/null", "diff-tree", "--stdin", "-p", "--text", "--no-renames", "--diff-algorithm=myers", "--indent-heuristic", "--no-ext-diff", "--no-textconv"],
      opts
    );
    const ids = spawn2("git", ["-C", repoRoot, "patch-id", "--stable"], opts);
    let text2 = "";
    let ok = true;
    let open2 = 2;
    const done = (code) => {
      if (code !== 0) ok = false;
      if (--open2 > 0) return;
      const out = {};
      if (ok) {
        for (const line of text2.split("\n")) {
          const [id, sha] = line.trim().split(/\s+/);
          if (id && sha) out[sha] = id;
        }
      }
      resolve(out);
    };
    for (const child of [diff, ids]) {
      let settled = false;
      const settle = (code) => void (settled || (settled = true, done(code)));
      child.on("error", () => settle(null));
      child.on("close", settle);
      child.stdin.on("error", () => ok = false);
    }
    diff.stdout.pipe(ids.stdin);
    ids.stdout.on("data", (d) => text2 += d);
    diff.stdin.end(commits.map((c) => c.base ? `${c.sha} ${c.base}` : c.sha).join("\n") + "\n");
  });
}
async function listRecentShas(repoRoot, sinceDays = 90) {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", repoRoot, "log", ...revRange("--all"), `--since=${sinceDays} days ago`, "--numstat", "--pretty=format:%x1e%H%x1f%cI%x1f%ae"],
      { maxBuffer: 64 * 1024 * 1024 }
    );
    return parseGitLogNumstat(stdout).slice(0, RECENT_SHA_CAP).map((c) => ({
      sha: c.sha,
      committedAt: c.committedAt.toISOString(),
      linesAdded: c.linesAdded,
      linesDeleted: c.linesDeleted,
      filesChanged: c.filesChanged,
      ...c.authorEmail ? { authorEmail: c.authorEmail } : {}
    }));
  } catch {
    return [];
  }
}
async function readUserEmail(repoRoot) {
  try {
    const { stdout } = await exec("git", ["-C", repoRoot, "config", "user.email"]);
    const email = stdout.trim().toLowerCase();
    return email || null;
  } catch {
    return null;
  }
}
async function listBranchTips(repoRoot) {
  try {
    const { stdout } = await exec(
      "git",
      [
        "-C",
        repoRoot,
        "for-each-ref",
        "--format=%(refname)%1f%(refname:short)%1f%(objectname)%1f%(committerdate:iso-strict)%1f%(symref)",
        "refs/heads",
        "refs/remotes"
      ],
      { maxBuffer: FACT_BUFFER }
    );
    const out = [];
    for (const line of stdout.split("\n")) {
      const [ref, name, sha, date, symref] = line.split("");
      if (!ref?.trim() || !name?.trim() || !sha?.trim()) continue;
      if (symref?.trim()) continue;
      if (name === "origin" || name === "origin/HEAD") continue;
      out.push({ ref: ref.trim(), name: name.trim(), sha: sha.trim(), tipDate: date?.trim() || null });
    }
    return out;
  } catch {
    return [];
  }
}
var REACHABLE_CAP = 5e4;
async function listReachableShas(repoRoot, ref, sinceDays = 90) {
  try {
    const { stdout } = await exec(
      "git",
      [
        "-C",
        repoRoot,
        "rev-list",
        `--since=${sinceDays} days ago`,
        `--max-count=${REACHABLE_CAP}`,
        ref,
        "--"
      ],
      { maxBuffer: FACT_BUFFER }
    );
    return stdout.split("\n").map((line) => line.trim()).filter((sha) => sha.length > 0);
  } catch {
    return [];
  }
}
async function cherryEquivalentShas(repoRoot, defaultRef, tipRef) {
  try {
    const { stdout } = await exec("git", ["-C", repoRoot, "cherry", defaultRef, tipRef], {
      maxBuffer: FACT_BUFFER
    });
    return stdout.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim()).filter((sha) => sha.length > 0);
  } catch {
    return [];
  }
}
var LOC_FILE_CAP = 5e3;
var LOC_BYTES_CAP = 1024 * 1024;
async function readRepoSize(repoRoot) {
  let files = [];
  try {
    const { stdout } = await exec("git", ["-C", repoRoot, "ls-files"], {
      maxBuffer: 64 * 1024 * 1024
    });
    files = stdout.split("\n").filter((f) => f.length > 0);
  } catch {
    return { totalLoc: null, fileCount: 0 };
  }
  const fileCount = files.length;
  if (fileCount > LOC_FILE_CAP) return { totalLoc: null, fileCount };
  let totalLoc = 0;
  for (const rel of files) {
    try {
      const content = await readFile10(`${repoRoot}/${rel}`);
      if (content.byteLength > LOC_BYTES_CAP) continue;
      if (content.includes(0)) continue;
      totalLoc += content.toString("utf-8").split("\n").length;
    } catch {
    }
  }
  return { totalLoc, fileCount };
}

// src/identity.ts
import { createHmac } from "node:crypto";
import { realpathSync as realpathSync3 } from "node:fs";
import { homedir as homedir8 } from "node:os";
import { readFile as readFile11 } from "node:fs/promises";
import { basename as basename5, dirname as dirname6, join as join13 } from "node:path";
function remoteKey(url) {
  const raw = url.trim();
  if (!raw) return null;
  let host;
  let path;
  let scp = false;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if (proto === "file") return null;
    let u;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    host = u.hostname;
    path = u.pathname;
  } else {
    const m = /^(?:[^@/]+@)?([^:/\\]{2,}):([^\\]+)$/.exec(raw);
    if (!m) return null;
    host = m[1];
    path = m[2];
    scp = true;
  }
  host = host.toLowerCase();
  if (!isHostedName(host)) return null;
  if (scp && path.startsWith("/") && !FORGES.has(host)) return null;
  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!host || !path) return null;
  if (path.startsWith("~") || !FORGES.has(host) && HOME_ROOT.test(path)) return null;
  if (host === "ssh.dev.azure.com") {
    const m = /^v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    if (!m) return null;
    host = "dev.azure.com";
    path = `${m[1]}/${m[2]}/_git/${m[3]}`;
  } else if (host === "vs-ssh.visualstudio.com") {
    const m = /^v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    if (!m) return null;
    host = `${m[1].toLowerCase()}.visualstudio.com`;
    path = `${m[2]}/_git/${m[3]}`;
  } else if (host.endsWith(".visualstudio.com")) {
    path = path.replace(/^defaultcollection\//i, "");
  }
  const key = `${host}/${path}`.toLowerCase();
  return /^[a-z0-9.-]+\/[^\s]+$/.test(key) ? key : null;
}
var FORGES = /* @__PURE__ */ new Set(["github.com", "gitlab.com", "bitbucket.org"]);
var HOME_ROOT = /^(?:home|users|root)(?:\/|$)/i;
var LAN_SUFFIXES = [".local", ".localhost", ".localdomain", ".lan", ".home.arpa"];
function isHostedName(host) {
  if (/^[0-9.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return false;
  if (!host.includes(".")) return false;
  return !LAN_SUFFIXES.some((s) => host.endsWith(s));
}
async function readRemoteKey(repoRoot) {
  let url = null;
  try {
    const { stdout } = await gitExec(["-C", repoRoot, "remote", "get-url", "origin"]);
    url = stdout.trim() || null;
  } catch {
  }
  if (!url) {
    try {
      const { stdout } = await gitExec(["-C", repoRoot, "remote"]);
      const first = stdout.split("\n").map((s) => s.trim()).find((s) => s.length > 0);
      if (first) {
        const r = await gitExec(["-C", repoRoot, "remote", "get-url", first]);
        url = r.stdout.trim() || null;
      }
    } catch {
    }
  }
  return url ? remoteKey(url) : null;
}
async function readRootSha(repoRoot) {
  const branch = await resolveDefaultBranch(repoRoot);
  const roots = await listRoots(repoRoot, branch ? `refs/heads/${branch}` : "--all");
  return roots[0] ?? null;
}
async function listRoots(repoRoot, ref) {
  try {
    const { stdout } = await gitExec(["-C", repoRoot, "rev-list", "--max-parents=0", ...revRange(ref)]);
    return stdout.split("\n").map((s) => s.trim()).filter((s) => /^[0-9a-f]{40,64}$/.test(s)).sort();
  } catch {
    return [];
  }
}
function displayLabel(path) {
  const p = path.replace(/[\/\\]+$/, "");
  const home = homedir8().replace(/[\/\\]+$/, "");
  if (samePath(p, home)) return "~";
  try {
    if (samePath(realpathSync3.native(p), realpathSync3.native(home))) return "~";
  } catch {
  }
  return basename5(p);
}
async function repoIdentity(repoRoot) {
  const label = displayLabel(repoRoot);
  const remote = await readRemoteKey(repoRoot);
  const root = await readRootSha(repoRoot);
  if (remote) return { key: remote, label, source: "remote", ...root ? { root } : {} };
  if (root) return { key: `sha:${root}`, label, source: "root", root };
  return null;
}
function folderIdentity(cwd, installId) {
  const digest = createHmac("sha256", installId).update(cwd).digest("hex").slice(0, 16);
  return { key: `dir:${digest}`, label: displayLabel(cwd), source: "folder" };
}
async function staleWorktree(dir) {
  let d = dir;
  for (; ; ) {
    try {
      const text2 = await readFile11(join13(d, ".git"), "utf-8");
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text2);
      const wt = m ? /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(m[1]) : null;
      return wt ? { folder: d, main: wt[1] } : null;
    } catch (err) {
      if (err.code === "EISDIR") return null;
    }
    const parent = dirname6(d);
    if (parent === d) return null;
    d = parent;
  }
}
async function readHeadState(repoRoot) {
  let branch = null;
  let head = null;
  try {
    const { stdout } = await gitExec(["-C", repoRoot, "symbolic-ref", "--short", "-q", "HEAD"]);
    branch = stdout.trim() || null;
  } catch {
  }
  try {
    const { stdout } = await gitExec(["-C", repoRoot, "rev-parse", "--verify", "-q", "HEAD"]);
    head = stdout.trim() || null;
  } catch {
  }
  return { branch, head };
}

// src/resolver.ts
import { basename as basename6 } from "node:path";

// src/sidecar.ts
import { appendFile, mkdir as mkdir5, readFile as readFile12, writeFile as writeFile5 } from "node:fs/promises";
import { dirname as dirname7 } from "node:path";
var SIDECAR_PATH = `${CONFIG_DIR}/sessions.jsonl`;
async function appendSidecar(line, path = SIDECAR_PATH) {
  await mkdir5(dirname7(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(line)}
`, { mode: 384 });
}
async function readSidecar(path = SIDECAR_PATH) {
  const out = /* @__PURE__ */ new Map();
  let text2;
  try {
    text2 = await readFile12(path, "utf-8");
  } catch {
    return out;
  }
  for (const raw of text2.split("\n")) {
    if (!raw.trim()) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isSidecarLine(line)) continue;
    out.set(line.sessionId, line);
  }
  return out;
}
var SIDECAR_RETENTION_DAYS = 90;
async function compactSidecar(path = SIDECAR_PATH, now = Date.now()) {
  let text2;
  try {
    text2 = await readFile12(path, "utf-8");
  } catch {
    return;
  }
  const keep = /* @__PURE__ */ new Map();
  const recent = [];
  const cutoff = now - 60 * 60 * 1e3;
  const lastSeen = /* @__PURE__ */ new Map();
  for (const raw of text2.split("\n")) {
    if (!raw.trim()) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isSidecarLine(line)) continue;
    const at = new Date(line.ts).getTime();
    lastSeen.set(line.sessionId, Math.max(lastSeen.get(line.sessionId) ?? -Infinity, at));
    if (at >= cutoff) recent.push(raw);
    else keep.set(line.sessionId, raw);
  }
  const expired = now - SIDECAR_RETENTION_DAYS * 24 * 60 * 60 * 1e3;
  for (const [sessionId, at] of lastSeen) if (at < expired) keep.delete(sessionId);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile5(tmp, [...keep.values(), ...recent].map((l) => `${l}
`).join(""), { mode: 384 });
  await replaceFile(tmp, path);
}
function isSidecarLine(v) {
  if (v === null || typeof v !== "object") return false;
  const o = v;
  return o.v === 1 && typeof o.ts === "string" && typeof o.surface === "string" && typeof o.sessionId === "string" && o.sessionId.length > 0 && typeof o.cwd === "string";
}

// src/resolver.ts
var IdentityResolver = class _IdentityResolver {
  constructor(installId, sidecar) {
    this.installId = installId;
    this.sidecar = sidecar;
  }
  rootByCwd = /* @__PURE__ */ new Map();
  identityByRoot = /* @__PURE__ */ new Map();
  existsByCwd = /* @__PURE__ */ new Map();
  static async create(installId, sidecarPath) {
    return new _IdentityResolver(installId, await readSidecar(sidecarPath));
  }
  // The transcript's `gitBranch` reads "HEAD" for a detached checkout and
  // for every worktree parked on a commit; the Stop hook recorded the branch
  // the session's cwd was on. The server prefers the session's own branch
  // among candidate commits, so the better name goes on the wire.
  fixBranch(e) {
    const current = e.metadata.gitBranch;
    if (current && current !== "HEAD") return;
    const line = e.metadata.sessionId ? this.sidecar.get(e.metadata.sessionId) : void 0;
    if (line?.branch) e.metadata.gitBranch = line.branch;
  }
  async stamp(e) {
    this.fixBranch(e);
    if (e.metadata.repo) return;
    const identity = await this.identityFor(e);
    if (identity) {
      e.metadata.repo = identity;
      e.metadata.placement = identity.source === "folder" ? "folder" : "cwd";
    }
  }
  // The repo a touched path falls under: first the roots the Stop hook
  // recorded for the session (the folder may be gone), then live git on
  // the path's directory. Null for a path in no repo. The most specific
  // root wins: a known root answers only when no checkout nested inside it
  // (a submodule) holds the path, so the answer never depends on which
  // turn resolved what first.
  async identityForPath(path, sessionId) {
    const roots = sessionId ? this.sidecar.get(sessionId)?.roots : void 0;
    const recorded = roots ? deepestRoot(Object.keys(roots), path) : null;
    if (recorded && await this.answers(recorded, path)) return roots[recorded];
    const live = deepestRoot(this.liveRoots, path);
    if (live && await this.answers(live, path)) return this.identityForRoot(live);
    const dir = await this.dirFor(path);
    if (!dir) return null;
    const root = await this.rootFor(dir);
    return root ? this.identityForRoot(root) : null;
  }
  // Whether a known root holds `path` itself, rather than a checkout nested
  // inside it. A path whose folder is gone climbs above the root: it holds.
  async answers(root, path) {
    const dir = await this.dirFor(path);
    if (!dir) return true;
    const k = `${root}\0${dir}`;
    let nested = this.nestedByDir.get(k);
    if (nested === void 0) this.nestedByDir.set(k, nested = await nestedCheckout(root, dir));
    return !nested;
  }
  async dirFor(path) {
    let dir = this.dirByPath.get(path);
    if (dir === void 0) this.dirByPath.set(path, dir = await nearestDirectory(path));
    return dir;
  }
  // The live checkout root for this event's cwd, or null when the folder is
  // gone or not a repo. Attribution reads commits from here.
  async liveRootFor(e) {
    const cwd = e.metadata.cwd;
    return cwd ? this.rootFor(cwd) : null;
  }
  // A live checkout of this identity that no event's cwd pointed at: any
  // root the hook recorded for the key that still exists, or the main
  // checkout it recorded for a worktree that is gone. Null when this
  // machine holds no live checkout — usage ships, commits wait.
  async liveRootForKey(key) {
    let known = this.liveRootByKey.get(key);
    if (known !== void 0) return known;
    known = null;
    for (const line of this.sidecar.values()) {
      for (const [path, id] of Object.entries(line.roots ?? {})) {
        if (id.key !== key) continue;
        for (const candidate of [path, line.mains?.[path]]) {
          if (!candidate) continue;
          const root = await this.rootFor(candidate);
          if (root && (await this.identityForRoot(root))?.key === key) {
            known = root;
            break;
          }
        }
        if (known) break;
      }
      if (known) break;
    }
    this.liveRootByKey.set(key, known);
    return known;
  }
  // The branch the Stop hook saw for this session, or null (detached / no
  // sidecar). A dead worktree's commits are read from this ref in a sibling.
  sidecarBranchFor(e) {
    const line = e.metadata.sessionId ? this.sidecar.get(e.metadata.sessionId) : void 0;
    return line?.branch ?? null;
  }
  async identityFor(e) {
    const cwd = e.metadata.cwd;
    const fromSidecar = e.metadata.sessionId ? this.sidecar.get(e.metadata.sessionId) : void 0;
    if (cwd) {
      const root = await this.rootFor(cwd);
      if (root) {
        const id = await this.identityForRoot(root);
        if (id) return id;
        return folderIdentity(cwd, this.installId);
      }
      if (fromSidecar?.repo) return fromSidecar.repo;
      if (await this.exists(cwd)) {
        const stale = await staleWorktree(cwd);
        const mainRoot = stale ? await this.rootFor(stale.main) : null;
        const id = mainRoot ? await this.identityForRoot(mainRoot) : null;
        if (id && stale) return { ...id, label: basename6(stale.folder) };
        return folderIdentity(cwd, this.installId);
      }
      if (fromSidecar) return folderIdentity(fromSidecar.cwd, this.installId);
      return null;
    }
    if (fromSidecar?.repo) return fromSidecar.repo;
    if (fromSidecar) return folderIdentity(fromSidecar.cwd, this.installId);
    return null;
  }
  liveRoots = /* @__PURE__ */ new Set();
  liveRootByKey = /* @__PURE__ */ new Map();
  dirByPath = /* @__PURE__ */ new Map();
  nestedByDir = /* @__PURE__ */ new Map();
  async rootFor(cwd) {
    let root = this.rootByCwd.get(cwd);
    if (root === void 0) {
      root = await resolveRepoRoot(cwd);
      this.rootByCwd.set(cwd, root);
      if (root) this.liveRoots.add(root);
    }
    return root;
  }
  async identityForRoot(root) {
    let id = this.identityByRoot.get(root);
    if (id === void 0) {
      id = await repoIdentity(root);
      this.identityByRoot.set(root, id);
    }
    return id;
  }
  async exists(cwd) {
    let known = this.existsByCwd.get(cwd);
    if (known === void 0) {
      try {
        known = (await stat9(cwd)).isDirectory();
      } catch {
        known = false;
      }
      this.existsByCwd.set(cwd, known);
    }
    return known;
  }
};

// src/scope.ts
function listHas(list, repo) {
  return list.includes(repo.key) || repo.label !== "" && list.includes(repo.label);
}
function repoStatus(repo, cfg) {
  if (repo && listHas(cfg.denyRepos, repo)) return "excluded";
  if (cfg.mode === "allow") return repo && listHas(cfg.allowRepos, repo) ? "synced" : "waiting";
  return "synced";
}
function eventInScope(e, cfg) {
  return repoStatus(e.metadata.repo, cfg) === "synced";
}
function surfaceEnabled(cfg, surface) {
  return cfg.surfaces[surface] !== false;
}
function summarizeRepos(events) {
  const rows = /* @__PURE__ */ new Map();
  for (const e of events) {
    const repo = e.metadata.repo;
    if (!repo) continue;
    let row = rows.get(repo.key);
    if (!row) {
      row = { key: repo.key, labels: [], source: repo.source, sessions: 0, events: 0, lastAt: e.occurredAt, sessionIds: /* @__PURE__ */ new Set() };
      rows.set(repo.key, row);
    }
    if (repo.label && !row.labels.includes(repo.label)) row.labels.push(repo.label);
    if (e.metadata.sessionId) row.sessionIds.add(e.metadata.sessionId);
    row.events++;
    if (e.occurredAt > row.lastAt) row.lastAt = e.occurredAt;
  }
  return [...rows.values()].map(({ sessionIds, ...r }) => ({ ...r, sessions: sessionIds.size })).sort((a, b) => b.events - a.events || a.key.localeCompare(b.key));
}
function shortKey(key) {
  return key.startsWith("sha:") ? `${key.slice(0, 12)}\u2026` : key;
}
function renderRepoRows(rows, cfg) {
  const width = Math.min(48, Math.max(20, ...rows.map((r) => shortKey(r.key).length)));
  return rows.map((r, i) => {
    const status2 = repoStatus({ key: r.key, label: r.labels[0] ?? "", source: r.source }, cfg);
    const mark = status2 === "synced" ? "\u2713" : status2 === "excluded" ? "\u2717" : "\u2026";
    const note = r.source === "root" ? "  (no remote)" : r.source === "folder" ? "  (not a repo)" : "";
    const label = r.labels.join(", ");
    return `${String(i + 1).padStart(3)}. ${mark} ${shortKey(r.key).padEnd(width)}  ${label.padEnd(24).slice(0, 24)}  ${String(r.sessions).padStart(5)} sessions${note}`;
  });
}
function parseSelection(answer, count3) {
  const trimmed = answer.trim().toLowerCase();
  if (!trimmed) return null;
  const only = trimmed.startsWith("only");
  const nums = (only ? trimmed.slice(4) : trimmed).split(/[\s,]+/).map((t) => Number.parseInt(t, 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= count3);
  if (nums.length === 0) return null;
  return { mode: only ? "allow" : "all", picks: [...new Set(nums)].map((n) => n - 1) };
}

// src/commands/scope.ts
var SCOPE_UNANSWERED = "Scope not answered: repo names held back; run `centrail scope`.";
function isInteractiveTerminal() {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}
async function discoverRepos() {
  const installId = await ensureInstallId();
  const resolver = await IdentityResolver.create(installId);
  const events = [];
  for (const scanner of SCANNERS) {
    try {
      for (const e of await scanner.scan({})) events.push(e);
    } catch {
    }
  }
  for (const e of events) await resolver.stamp(e);
  return summarizeRepos(events);
}
async function runSetup(opts) {
  console.log("  Scanning local agent logs\u2026");
  const rows = await discoverRepos();
  const cfg = await readConfig();
  printScope(rows, cfg);
  if (rows.length === 0 || !opts.interactive) {
    if (!cfg.scopeDecidedAt) {
      recordAnswer(cfg);
      await writeConfig(cfg);
    }
    console.log("  Change any time: `centrail scope`, `centrail exclude <repo>`, `centrail repos`.");
    return;
  }
  const rl = createInterface2({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    process.stdout.write(prompt);
    const next = await lines.next();
    if (next.done) process.stdout.write("\n");
    return next.done ? "" : String(next.value);
  };
  try {
    const all = (await ask("  Sync all of these, and any new repo this machine touches? [Y/n] ")).trim().toLowerCase();
    if (all === "" || all.startsWith("y")) {
      if (cfg.mode === "allow") cfg.pendingBackfill = true;
      cfg.mode = "all";
    } else {
      const answer = await ask("  Numbers to EXCLUDE (e.g. 2,5), or `only 1,3` to sync just those: ");
      const sel = parseSelection(answer, rows.length);
      if (sel) {
        const keys = sel.picks.map((i) => rows[i].key);
        if (sel.mode === "allow") {
          cfg.mode = "allow";
          cfg.allowRepos = keys;
          cfg.pendingBackfill = true;
        } else {
          cfg.mode = "all";
          for (const k of keys) if (!cfg.denyRepos.includes(k)) cfg.denyRepos.push(k);
        }
      }
    }
  } finally {
    rl.close();
  }
  recordAnswer(cfg);
  await writeConfig(cfg);
  console.log("");
  printScope(rows, cfg);
  console.log("  Saved. Change any time: `centrail exclude <repo>`, `centrail include <repo>`, `centrail repos`.");
}
function recordAnswer(cfg) {
  if (!cfg.scopeDecidedAt) cfg.pendingBackfill = true;
  cfg.scopeDecidedAt = (/* @__PURE__ */ new Date()).toISOString();
}
async function runRepos() {
  const cfg = await readConfig();
  printScope(await discoverRepos(), cfg);
  if (!cfg.scopeDecidedAt) console.log(`  ${SCOPE_UNANSWERED}`);
}
async function runInspect() {
  console.log(await readLastSync() ?? "No sync has run on this machine yet.");
  if (!(await readConfig()).scopeDecidedAt) console.error(SCOPE_UNANSWERED);
}
function printScope(rows, cfg) {
  const repos = rows.filter((r) => r.source !== "folder").length;
  const folders = rows.length - repos;
  console.log("");
  console.log(`  This machine's agents have touched ${repos} repo(s) and ${folders} folder(s):`);
  for (const line of renderRepoRows(rows, cfg)) console.log(`  ${line}`);
  if (rows.length === 0) console.log("    (nothing yet)");
  const legend = cfg.mode === "allow" ? "\u2713 synced  \u2717 excluded  \u2026 waiting (allow mode: only listed repos sync)" : "\u2713 synced  \u2717 excluded";
  console.log(`  ${legend}`);
  const surfaces = SCANNERS.map((s) => `${s.surface} ${surfaceEnabled(cfg, s.surface) ? "on" : "off"}`).join("  ");
  console.log(`  Surfaces: ${surfaces}   (centrail surfaces <name> on|off)`);
}
async function runInclude(name) {
  const cfg = await updateConfig((c) => {
    c.denyRepos = c.denyRepos.filter((r) => r !== name);
    if (!c.allowRepos.includes(name)) c.allowRepos.push(name);
    c.pendingBackfill = true;
  });
  console.log(
    cfg.mode === "allow" ? `Included "${name}" \u2014 it syncs from the next run.` : `Included "${name}" \u2014 it was ${cfg.denyRepos.includes(name) ? "excluded" : "already syncing"} (mode: all).`
  );
}
async function runExclude(name) {
  await updateConfig((c) => {
    c.allowRepos = c.allowRepos.filter((r) => r !== name);
    if (!c.denyRepos.includes(name)) c.denyRepos.push(name);
  });
  console.log(`Excluded "${name}" \u2014 nothing about it leaves this machine from the next sync (events, commits, identity).`);
}
async function runSurfaces(args) {
  const [name, state] = args;
  const known = SCANNERS.map((s) => s.surface);
  if (!name) {
    const cfg = await readConfig();
    for (const s of known) console.log(`  ${s.padEnd(12)} ${surfaceEnabled(cfg, s) ? "on" : "off"}`);
    return;
  }
  if (!known.includes(name) || state !== "on" && state !== "off") {
    throw new Error(`Usage: centrail surfaces <${known.join("|")}> on|off`);
  }
  await updateConfig((c) => {
    c.surfaces[name] = state === "on";
  });
  console.log(`${name}: ${state}`);
}

// src/commands/integrations.ts
var AGENTS = ["claude-code", ...AGENT_HOOKS.map((h) => h.agent)];
var IDENTITY_ONLY = AGENT_HOOKS.filter((h) => !h.usage).map((h) => h.agent);
var LABEL = Object.fromEntries([["claude-code", "Claude Code"], ...AGENT_HOOKS.map((h) => [h.agent, h.label])]);
var hookFor = (agent) => AGENT_HOOKS.find((h) => h.agent === agent);
function parseAgents(names) {
  if (names.length === 0) return void 0;
  const out = [];
  for (const name of names.flatMap((n) => n.split(",")).map((n) => n.trim()).filter(Boolean)) {
    if (!AGENTS.includes(name)) throw new Error(`Unknown agent "${name}": use ${AGENTS.slice(0, -1).join(", ")} or ${AGENTS.at(-1)}.`);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
function context(deps) {
  const platform = deps.platform ?? process.platform;
  const claudeDir = deps.claudeDir ?? claudeConfigDirs()[0];
  const given = {
    codex: deps.codexHome,
    "gemini-cli": deps.geminiHome,
    "copilot-cli": deps.copilotHome,
    pi: deps.piAgentDir,
    cursor: deps.cursorHome,
    opencode: deps.opencodeConfigDir
  };
  const homes = Object.fromEntries(AGENT_HOOKS.map((h) => [h.agent, given[h.agent] ?? defaultHome(h.agent)]));
  const files = Object.fromEntries(AGENT_HOOKS.map((h) => [h.agent, h.file(homes[h.agent])]));
  return {
    env: deps.env ?? process.env,
    platform,
    claudeDir,
    claudeSettings: join14(claudeDir, "settings.json"),
    homes,
    files,
    launcher: launcherPath(deps.configDir ?? CONFIG_DIR, platform),
    recordedNode: join14(deps.configDir ?? CONFIG_DIR, "node"),
    script: deps.script ?? process.argv[1] ?? "",
    node: deps.node ?? process.execPath,
    deps
  };
}
async function inspectIntegrations(deps = {}) {
  const ctx = context(deps);
  const content = await readLauncher(ctx.launcher);
  const recorded = content ? launcherScriptPath(content) : null;
  const previous = recorded && await exists2(recorded) ? recorded : null;
  const target = launcherTarget(ctx.script, ctx.node, previous, ctx.env);
  const expected = launcherScript(target, ctx.platform);
  const executable = content !== null && await isExecutable(ctx.launcher, ctx.platform);
  const launcher = {
    path: ctx.launcher,
    present: content !== null,
    executable,
    current: content === expected && executable,
    script: recorded,
    resolvesCli: executable && (previous !== null || await cliReachable(ctx, content ? launcherValue(content, "pinned") : null))
  };
  const expectedResolves = target.script !== null || await cliReachable(ctx, target.node);
  const claudeCli = ctx.deps.claude === void 0 ? await findExecutable("claude", ctx.env, ctx.platform) : ctx.deps.claude ? "claude" : null;
  const claudeFile = await readClaudeSettings(ctx);
  const settings = claudeFile.settings;
  const entry = marketplaceEntry(settings);
  const claude = {
    ...claudeFile,
    detected: claudeCli !== null || await isDir(ctx.claudeDir),
    cli: claudeCli,
    plugin: {
      enabled: pluginEnabled(settings),
      autoUpdate: entry?.autoUpdate === true,
      release: isReleaseSource(entry?.source),
      version: await installedPluginVersion(ctx.claudeDir)
    }
  };
  const agents = { "claude-code": claude };
  for (const hook of AGENT_HOOKS) {
    const cli = await findExecutable(hook.bin, ctx.env, ctx.platform);
    const file = await hook.read(ctx.files[hook.agent], ctx.launcher, ctx.platform);
    agents[hook.agent] = { ...file, detected: cli !== null || await isDir(ctx.homes[hook.agent]), cli };
  }
  return { claude, agents, launcher, expected, expectedResolves };
}
async function cliReachable(ctx, pinnedNode) {
  const recorded = (await readFile13(ctx.recordedNode, "utf-8").catch(() => "")).trim();
  const beside = [recorded, pinnedNode].filter((n) => Boolean(n)).map((n) => ctx.platform === "win32" ? win324.dirname(n) : dirname8(n));
  const path = [ctx.env.PATH ?? ctx.env.Path ?? "", ...beside].filter(Boolean).join(ctx.platform === "win32" ? ";" : ":");
  const env = { ...ctx.env, PATH: path };
  for (const name of ["centrail", "npx"]) if (await findExecutable(name, env, ctx.platform)) return true;
  return false;
}
async function readClaudeSettings(ctx) {
  let file;
  try {
    file = await readSettingsFile(ctx.claudeSettings);
  } catch {
    return { readable: false, settings: {}, indent: "  ", hooks: [] };
  }
  const expected = launcherCommand(ctx.launcher, "claude-code", ctx.platform);
  const hooks = await Promise.all(groupCommands(file.settings).filter(isCentrailCommand).map((c) => classifyCommand(c, expected, ctx.platform)));
  return { readable: true, ...file, hooks };
}
async function installedPluginVersion(claudeDir = claudeConfigDirs()[0]) {
  try {
    const raw = JSON.parse(await readFile13(join14(claudeDir, "plugins", "installed_plugins.json"), "utf-8"));
    const entry = raw?.plugins?.[PLUGIN_ID];
    const versions = (Array.isArray(entry) ? entry : [entry]).map((e) => isObject10(e) ? e.version : void 0).filter(validVersion);
    return versions.sort(compareVersions).pop() ?? null;
  } catch {
    return null;
  }
}
function planSetup(ins, agents) {
  return AGENTS.map((agent) => {
    const state = ins.agents[agent];
    const skip = (detail) => ({ agent, action: "skip", via: null, detail });
    if (agents && !agents.includes(agent)) return skip("not selected");
    if (!state.detected) return skip("not detected");
    if (!state.readable) {
      if (agent !== "claude-code" && hookFor(agent).module) return skip(`${hookFor(agent).fileName.replaceAll("\\", "/")} is not centrail's; move it, then rerun`);
      return skip(`${agent === "claude-code" ? "settings.json" : hookFor(agent).fileName.replaceAll("\\", "/")} does not parse; fix it, then rerun`);
    }
    if (IDENTITY_ONLY.includes(agent) && state.hooks.length === 0 && !agents?.includes(agent)) {
      return skip(`${NOT_SUPPORTED}; \`--agent ${agent}\` adds a repo-identity-only ${HOW[agent]}`);
    }
    if (agent === "claude-code") {
      const { plugin, hooks } = ins.claude;
      if (plugin.enabled) {
        const fixes = [
          ...plugin.autoUpdate && plugin.release ? [] : [`turn on auto-update from #${RELEASE_REF}`],
          ...hooks.length ? [`remove ${hooks.length} standalone hook${hooks.length > 1 ? "s" : ""}`] : []
        ];
        const version = plugin.version ? ` ${plugin.version}` : "";
        return fixes.length ? { agent, action: "repair", via: "plugin", detail: `plugin${version}: ${fixes.join(", ")}` } : { agent, action: "ok", via: "plugin", detail: `plugin${version}, updated by Claude Code` };
      }
      if (ins.claude.cli) {
        const replaces = hooks.length ? "; replaces the standalone hook" : "";
        return { agent, action: "install", via: "plugin", detail: `plugin ${PLUGIN_ID} from ${MARKETPLACE_REPO}#${RELEASE_REF}, auto-update on${replaces}` };
      }
    }
    return hookPlan(agent, state.hooks, ins.launcher, agent === "claude-code" ? " (no `claude` command for the plugin)" : "");
  });
}
var NOT_SUPPORTED = "usage collection not supported yet (no usage source)";
var HOW = Object.fromEntries([["claude-code", "Stop hook"], ...AGENT_HOOKS.map((h) => [h.agent, h.how])]);
function hookPlan(agent, hooks, launcher, why) {
  const via = "hook";
  const how = HOW[agent];
  if (hooks.length > 1) return { agent, action: "repair", via, detail: `${hooks.length} centrail ${how}s \u2192 one, through the launcher` };
  const only = IDENTITY_ONLY.includes(agent) ? ", repo identity only" : "";
  if (hooks.length === 0) return { agent, action: "install", via, detail: `${how} through the launcher${why}${only}` };
  if (!hooks[0].current) return { agent, action: "update", via, detail: `outdated ${hooks[0].form === "pinned" ? "pinned command" : how} \u2192 the launcher` };
  if (!launcher.current) return { agent, action: "update", via, detail: "refresh the launcher" };
  return { agent, action: "ok", via, detail: `${how} through the launcher${only}` };
}
var pending = (item) => item.action !== "ok" && item.action !== "skip";
function printPlan(items, launcher, title) {
  console.log(title);
  for (const i of items) console.log(`  ${LABEL[i.agent].padEnd(12)} ${i.action.padEnd(8)} ${i.detail}`);
  if (items.some((i) => i.via === "hook" && i.action !== "skip")) {
    const action = !launcher.present ? "install" : launcher.current ? "ok" : "update";
    console.log(`  ${"launcher".padEnd(12)} ${action.padEnd(8)} ${launcher.path}`);
  }
}
async function runIntegrationSetup(opts, deps = {}) {
  const ctx = context(deps);
  const ins = await inspectIntegrations(deps);
  const plan = planSetup(ins, opts.agents);
  if (!plan.some((i) => i.action !== "skip" || i.detail !== "not detected")) {
    console.log(`No supported agent found here (${AGENTS.map((a) => LABEL[a]).join(", ")}). Install one, then run \`centrail setup\`.`);
    return { plan, changed: false };
  }
  printPlan(plan, ins.launcher, "centrail setup:");
  const usesLauncher = plan.some((i) => i.via === "hook" && pending(i));
  if (plan.some((i) => i.via === "hook" && i.action !== "skip") && !ins.expectedResolves) {
    console.log("  Note: the launcher finds no centrail to run here (no stable install, `centrail` or `npx` on PATH).");
    console.log("    Install one for agents to use: `npm i -g centrail` (or `mise use -g npm:centrail`), then rerun `centrail setup`.");
  }
  if (!plan.some(pending)) {
    console.log("Everything is set up; nothing to change.");
    return { plan, changed: false };
  }
  if (opts.dryRun) {
    console.log("Dry run: nothing changed.");
    return { plan, changed: false };
  }
  if (!await confirm(opts, deps, "Apply this? [Y/n] ", "centrail setup -y")) return { plan, changed: false };
  if (!(await readConfig()).scopeDecidedAt) await (deps.scope ?? (() => runSetup({ interactive: opts.interactive === true })))();
  if (usesLauncher) await writeLauncher(ins.expected, ctx.launcher);
  for (const item of plan.filter(pending)) {
    if (item.agent === "claude-code") await applyClaude(ctx, ins, item);
    else await applyHook(ctx, item.agent);
  }
  if (plan.some((i) => i.agent === "codex" && pending(i))) {
    console.log("  Codex: open /hooks in Codex once and trust centrail's Stop hook. Codex trusts a hook by its hash;");
    console.log("    this command stays the same across centrail releases, so later updates need no new trust. Restart open sessions.");
  }
  const atStart = plan.filter((i) => ["gemini-cli", "copilot-cli", "pi", "opencode"].includes(i.agent) && pending(i)).map((i) => LABEL[i.agent]);
  if (atStart.length) console.log(`  ${listed(atStart)} read${atStart.length > 1 ? "" : "s"} hooks, extensions and plugins at start: restart open sessions.`);
  const identity = plan.filter((i) => IDENTITY_ONLY.includes(i.agent) && pending(i)).map((i) => LABEL[i.agent]);
  if (identity.length) {
    console.log(`  ${listed(identity)}: repo identity only. centrail cannot read ${identity.length > 1 ? "their" : "its"} usage yet, so these turns`);
    console.log("    show no tokens or cost until a usage source for them ships.");
  }
  console.log("Each turn now records session id, folder, repo identity, branch, head and the repos its files touched,");
  console.log("locally, and starts a background `centrail sync` at most every 10 minutes.");
  console.log("Nothing leaves this machine except what `centrail inspect --last` shows. Check any time: `centrail doctor`.");
  return { plan, changed: true };
}
async function applyClaude(ctx, ins, item) {
  const claude = claudeRunner(ctx, ins);
  if (item.via === "plugin" && claude) {
    if (await setUpPlugin(claude, ctx.claudeSettings)) return;
    console.log("  Recording Claude Code turns through a standalone Stop hook until the plugin installs; rerun `centrail setup` to switch.");
    await writeLauncher(ins.expected, ctx.launcher);
    await applyClaudeHook(ctx);
    return;
  }
  if (item.via === "plugin") {
    const { settings, indent } = await readSettingsFile(ctx.claudeSettings);
    const entry = marketplaceEntry(settings) ?? { source: RELEASE_SOURCE };
    const next = uninstallStopHook(withMarketplace(settings, { ...entry, source: RELEASE_SOURCE, autoUpdate: true }));
    await writeSettingsFile(ctx.claudeSettings, next, indent);
    console.log(`  \u2713 Claude Code plugin: auto-update on from #${RELEASE_REF}; standalone centrail hooks removed.`);
    return;
  }
  await applyClaudeHook(ctx);
}
async function applyClaudeHook(ctx) {
  const { settings, indent } = await readSettingsFile(ctx.claudeSettings);
  await writeSettingsFile(ctx.claudeSettings, installStopHook(settings, launcherCommand(ctx.launcher, "claude-code", ctx.platform)), indent);
  console.log(`  \u2713 Claude Code: Stop hook in ${ctx.claudeSettings} runs the launcher.`);
}
async function applyHook(ctx, agent) {
  const hook = hookFor(agent);
  await hook.install(ctx.files[agent], ctx.launcher, ctx.platform);
  console.log(`  \u2713 ${hook.label}: ${hook.how} in ${ctx.files[agent]} runs the launcher.`);
}
function claudeRunner(ctx, ins) {
  if (ctx.deps.claude !== void 0) return ctx.deps.claude;
  return ins.claude.cli ? runnerFor(ins.claude.cli, ctx.platform) : null;
}
async function runUninstall(opts, deps = {}) {
  const ctx = context(deps);
  const ins = await inspectIntegrations(deps);
  const selected = (a) => !opts.agents || opts.agents.includes(a);
  const removePlugin = selected("claude-code") && !opts.keepPlugin && ins.claude.plugin.enabled;
  const hookFiles = AGENTS.filter((a) => selected(a) && ins.agents[a].hooks.length > 0);
  const launcherKept = AGENTS.some((a) => !selected(a) && ins.agents[a].hooks.some((h) => h.form === "launcher"));
  const removeLauncherFile = ins.launcher.present && !launcherKept;
  const lines = [
    ...removePlugin ? [`  ${"Claude Code".padEnd(12)} remove   plugin ${PLUGIN_ID} and its marketplace`] : [],
    ...hookFiles.map((a) => {
      const n = ins.agents[a].hooks.length;
      return `  ${LABEL[a].padEnd(12)} remove   ${a !== "claude-code" && hookFor(a).module ? `centrail's ${HOW[a]}` : `${n} centrail ${HOW[a]}${n > 1 ? "s" : ""}`}`;
    }),
    ...removeLauncherFile ? [`  ${"launcher".padEnd(12)} remove   ${ins.launcher.path}`] : []
  ];
  if (lines.length === 0) {
    console.log("Nothing of centrail's is installed in these agents.");
    return { changed: false };
  }
  console.log("centrail uninstall:");
  for (const l of lines) console.log(l);
  if (!await confirm(opts, deps, "Remove these? [y/N] ", "centrail uninstall -y", false)) return { changed: false };
  if (removePlugin) {
    const claude = claudeRunner(ctx, ins);
    if (!claude) {
      console.log(`  Claude Code: run \`/plugin uninstall ${PLUGIN_ID}\` in Claude Code (no \`claude\` command here).`);
    } else {
      for (const args of [["plugin", "uninstall", PLUGIN_ID, "--scope", "user"], ["plugin", "marketplace", "remove", MARKETPLACE]]) {
        const r = await claude(args);
        const why = r.output.trim().split("\n").filter(Boolean).pop() ?? `exit ${r.code}`;
        console.log(r.code === 0 ? `  \u2713 claude ${args.slice(0, -1).join(" ")}` : `  \u2717 \`claude ${args.join(" ")}\` failed: ${why}`);
      }
    }
  }
  for (const agent of hookFiles) {
    const path = agent === "claude-code" ? ctx.claudeSettings : ctx.files[agent];
    if (agent === "claude-code") {
      const { settings, indent } = await readSettingsFile(path);
      await writeSettingsFile(path, uninstallStopHook(settings), indent);
    } else await hookFor(agent).uninstall(path);
    console.log(`  \u2713 ${LABEL[agent]}: removed centrail's ${HOW[agent]} from ${path}.`);
  }
  if (removeLauncherFile && await removeLauncher(ins.launcher.path)) console.log("  \u2713 Removed the launcher.");
  console.log("Restart or reload open agent sessions. Local usage logs and centrail's pairing are untouched (`centrail sync` still works).");
  return { changed: true };
}
async function confirm(opts, deps, prompt, unattended, byDefault = true) {
  if (opts.yes) return true;
  if (!opts.interactive) {
    console.log(`Nothing changed: no terminal to confirm in. Run \`${unattended}\` to apply without asking.`);
    return false;
  }
  const reply = await (deps.ask ?? askLine)(`  ${prompt}`);
  const answer = reply?.trim().toLowerCase();
  const yes = answer === void 0 ? false : answer === "" ? byDefault : answer.startsWith("y");
  if (!yes) console.log("Nothing changed.");
  return yes;
}
function listed(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}
async function isDir(p) {
  try {
    return (await stat10(p)).isDirectory();
  } catch {
    return false;
  }
}
async function exists2(p) {
  try {
    await stat10(p);
    return true;
  } catch {
    return false;
  }
}
function isObject10(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// src/url.ts
var LOOPBACK = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1"]);
function assertSecureBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid server URL: ${raw}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const isLoopback = LOOPBACK.has(host);
  if (url.protocol === "https:") return raw;
  if (url.protocol === "http:" && isLoopback) return raw;
  throw new Error(
    `Refusing to send your token over an insecure connection (${url.protocol}//${url.host}). Use https:// \u2014 http:// is allowed only for localhost.`
  );
}

// src/commands/connect.ts
var DEFAULT_BASE_URL = "https://centrail.org";
var PRIVATE_DEVICE_NAME = "Centrail CLI";
async function runConnect(opts, setupDeps = {}) {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  assertSecureBaseUrl(baseUrl);
  const previous = await readAuth();
  if (previous) {
    console.log("");
    console.log(`  This machine is paired${previous.account ? ` with ${previous.account.email}` : ""}. Approving below re-pairs it;`);
    console.log("  approve as another account and it moves there. The first sync re-reads its local history");
    console.log("  into the new account; the old account keeps the copy it already received.");
  }
  const config = await readConfig();
  const installId = config.scopeDecidedAt && config.installId ? config.installId : void 0;
  const res = await fetch(`${baseUrl}/api/cli/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", ...versionHeaders() },
    // The current server calls this field hostname, but it is only a display
    // label. Never send the operating-system hostname or other fingerprinting
    // data during pairing.
    body: JSON.stringify({ hostname: PRIVATE_DEVICE_NAME, ...installId ? { installId } : {} })
  });
  if (res.status === 426) {
    const minimum = await minimumFrom(res);
    throw new Error(`centrail ${CLI_VERSION} is older than ${new URL(baseUrl).host} pairs with${minimum ? ` (${minimum} or newer)` : ""}: ${howToUpdate(here().channel)}.`);
  }
  if (!res.ok) {
    throw new Error(
      `Pairing request failed (${res.status}) \u2014 is ${baseUrl} reachable?`
    );
  }
  const pair = await res.json();
  console.log("");
  console.log(`  Visit:  ${pair.verificationUrl}`);
  console.log(`  Code:   ${pair.code}`);
  console.log("");
  if (!opts.noBrowser && shouldOpenBrowser() && openBrowser(pair.verificationUrl, baseUrl)) {
    console.log("  Opened in your browser. Check the code matches, then approve.");
  }
  console.log("  Waiting for authorization...");
  const deadline = Date.now() + pair.expiresIn * 1e3;
  while (Date.now() < deadline) {
    await sleep(pair.interval * 1e3);
    let poll;
    try {
      poll = await fetch(`${baseUrl}/api/cli/pair/poll`, {
        method: "POST",
        headers: { "content-type": "application/json", ...versionHeaders() },
        body: JSON.stringify({ pollToken: pair.pollToken })
      });
    } catch {
      continue;
    }
    if (!poll.ok) continue;
    const body = await poll.json();
    if (body.status === "approved" && body.token) {
      const email = typeof body.account?.email === "string" && body.account.email ? body.account.email : void 0;
      await writeAuth({
        baseUrl,
        token: body.token,
        deviceName: PRIVATE_DEVICE_NAME,
        ...email ? { account: { email } } : {}
      });
      if (!email || previous?.account?.email !== email) await forgetWatermarks();
      console.log(email ? `  \u2713 Paired with ${email}` : `  \u2713 Paired (${PRIVATE_DEVICE_NAME})`);
      if (email && previous?.account?.email && previous.account.email !== email) {
        console.log(`  ${previous.account.email} keeps its existing copy; ${email} gets the local history this machine can still read.`);
      }
      await reportDetectedLogs();
      console.log(FIELDS_SHOWN_ONCE);
      await runSetup({ interactive: process.stdin.isTTY === true });
      console.log("");
      if (isInteractiveTerminal()) {
        try {
          await runIntegrationSetup({ interactive: true }, setupDeps);
        } catch (err) {
          console.log(`  Agent setup did not finish (${err instanceof Error ? err.message : String(err)}); run \`centrail setup\` to retry.`);
        }
      } else {
        console.log("  To sync after every agent turn (Claude Code, Codex), run `npx centrail setup` in a terminal.");
      }
      console.log("");
      console.log("  Run `npx centrail sync` to push usage now.");
      return;
    }
    if (body.status === "expired") {
      throw new Error(
        "Pairing expired or was already used \u2014 run `centrail connect` again"
      );
    }
  }
  throw new Error("Pairing timed out \u2014 run `centrail connect` again");
}
async function forgetWatermarks() {
  const state = await readState();
  if (Object.keys(state.surfaces).length === 0 && !state.lastSyncAt) return;
  state.surfaces = {};
  state.lastSyncAt = null;
  await writeState(state);
}
async function reportDetectedLogs() {
  const dirs = claudeProjectDirs();
  const found = [];
  let total = 0;
  for (const dir of dirs) {
    try {
      const entries = await readdir6(dir);
      found.push(dir);
      total += entries.length;
    } catch {
    }
  }
  if (found.length > 0) {
    console.log(
      `  \u2713 Found Claude Code logs: ${found.join(", ")} (${total} project folders)`
    );
  } else {
    console.log(
      `  \u26A0 No Claude Code logs found (looked in ${dirs.join(", ")}) \u2014 nothing to sync yet.`
    );
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var FIELDS_SHOWN_ONCE = `
  What leaves this machine on each sync \u2014 and nothing else:
    tokens per model, timestamps, the agent and CLI version, session id,
    repo identity (host/owner/repo or a root-commit hash), folder name,
    branch, commit shas, line counts and change hashes (git patch-id),
    a random per-install id.
  Never: source, prompts, completions, secrets, paths, hostname, platform,
  account details.
  Verify any time:  npx centrail inspect --last
  Toggles in ~/.config/centrail/config.json: hideRepoNames, hideBranchNames.
`;

// src/commands/hook.ts
import { spawn as spawn3 } from "node:child_process";
import { realpathSync as realpathSync4 } from "node:fs";
import { mkdir as mkdir7, open, readdir as readdir7, rm as rm5, stat as stat12 } from "node:fs/promises";
import { dirname as dirname9, join as join16 } from "node:path";

// src/sync-lock.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { mkdir as mkdir6, readFile as readFile14, rename as rename2, rm as rm4, stat as stat11, utimes, writeFile as writeFile6 } from "node:fs/promises";
import { hostname } from "node:os";
import { join as join15 } from "node:path";
var LOCK_PATH = join15(CONFIG_DIR, "sync.lock");
var OWNER_FILE = "owner.json";
var LOCK_STALE_MS = 15 * 60 * 1e3;
var LOCK_HEARTBEAT_MS = 30 * 1e3;
var LOCK_ABANDONED_MS = 60 * 60 * 1e3;
var GUARD_STALE_MS = 60 * 1e3;
function syncOrigin(env = process.env) {
  return env.CENTRAIL_SYNC_ORIGIN === "hook" ? "hook" : "command";
}
async function claimSyncLock(lockPath = LOCK_PATH, opts = {}) {
  const now = opts.now ?? Date.now;
  const host = opts.host ?? hostname();
  const isAlive = opts.isAlive ?? processIsAlive;
  await mkdir6(join15(lockPath, ".."), { recursive: true });
  let reclaimed;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir6(lockPath);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const holder = await readHolder(lockPath, host);
      if (!holder) continue;
      if (!abandoned(holder, now(), isAlive)) return { held: holder };
      if (!await reclaim(lockPath, holder, host, now)) {
        const current = await readHolder(lockPath, host);
        if (current) return { held: current };
        continue;
      }
      reclaimed = holder;
      continue;
    }
    const owner = {
      pid: process.pid,
      nonce: randomUUID2(),
      host,
      startedAt: new Date(now()).toISOString(),
      copy: detectChannel(),
      version: CLI_VERSION,
      purpose: opts.purpose ?? "sync",
      origin: syncOrigin()
    };
    const ownerPath = join15(lockPath, OWNER_FILE);
    try {
      await writeFile6(ownerPath, JSON.stringify(owner), { mode: 384 });
    } catch (err) {
      await rm4(lockPath, { recursive: true, force: true });
      throw err;
    }
    const beat = setInterval(() => {
      const t = /* @__PURE__ */ new Date();
      void utimes(ownerPath, t, t).catch(() => {
      });
    }, opts.heartbeatMs ?? LOCK_HEARTBEAT_MS);
    beat.unref();
    return {
      ...reclaimed ? { reclaimed } : {},
      release: async () => {
        clearInterval(beat);
        const current = await readOwner(lockPath);
        if (current?.nonce === owner.nonce) await rm4(lockPath, { recursive: true, force: true });
      }
    };
  }
  return { held: await readHolder(lockPath, host) };
}
async function acquireSyncLock(lockPath = LOCK_PATH, opts = {}) {
  const claim = await claimSyncLock(lockPath, opts);
  return "release" in claim ? claim.release : null;
}
function abandoned(holder, now, isAlive = processIsAlive) {
  const silentMs = now - holder.touchedAt.getTime();
  const { owner } = holder;
  if (!owner || holder.foreignHost) return silentMs >= LOCK_STALE_MS;
  if (!isAlive(owner.pid)) return true;
  return owner.startedAt !== void 0 && silentMs >= LOCK_ABANDONED_MS;
}
var RENAME_BUSY = /* @__PURE__ */ new Set(["EPERM", "EBUSY", "EACCES"]);
var RENAME_RETRIES = 20;
var RENAME_RETRY_MS = 50;
async function reclaim(lockPath, judged, host, now) {
  const guard = `${lockPath}.reclaim`;
  try {
    await mkdir6(guard);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const age = await stat11(guard).then((s) => now() - s.mtimeMs, () => 0);
    if (age < GUARD_STALE_MS) return false;
    await rm4(guard, { recursive: true, force: true });
    try {
      await mkdir6(guard);
    } catch {
      return false;
    }
  }
  try {
    const current = await readHolder(lockPath, host);
    if (!current) return true;
    const same = judged.owner ? current.owner?.nonce === judged.owner.nonce : !current.owner;
    if (!same) return false;
    const aside = `${lockPath}.stale-${randomUUID2()}`;
    for (let attempt = 0; ; attempt++) {
      try {
        await rename2(lockPath, aside);
        break;
      } catch (err) {
        const code = err.code;
        if (code === "ENOENT") return true;
        if (!RENAME_BUSY.has(code ?? "")) throw err;
        if (attempt >= RENAME_RETRIES) return false;
        await new Promise((r) => setTimeout(r, RENAME_RETRY_MS));
      }
    }
    await rm4(aside, { recursive: true, force: true });
    return true;
  } finally {
    await rm4(guard, { recursive: true, force: true });
  }
}
async function readHolder(lockPath, host) {
  const owner = await readOwner(lockPath);
  let touched;
  try {
    const dir = (await stat11(lockPath)).mtimeMs;
    const file = await stat11(join15(lockPath, OWNER_FILE)).then((s) => s.mtimeMs, () => 0);
    touched = Math.max(dir, file);
  } catch {
    return null;
  }
  return {
    owner,
    touchedAt: new Date(touched),
    foreignHost: owner?.host !== void 0 && owner.host !== host
  };
}
async function readOwner(lockPath) {
  try {
    const raw = JSON.parse(await readFile14(join15(lockPath, OWNER_FILE), "utf-8"));
    if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0 || typeof raw.nonce !== "string" || raw.nonce.length === 0) {
      return null;
    }
    const str = (v) => typeof v === "string" && v.length > 0 && v.length < 256 ? v : void 0;
    const startedAt = str(raw.startedAt);
    const copy = str(raw.copy);
    return {
      pid: raw.pid,
      nonce: raw.nonce,
      ...str(raw.host) ? { host: str(raw.host) } : {},
      ...startedAt && !Number.isNaN(new Date(startedAt).getTime()) ? { startedAt } : {},
      ...copy && ["plugin", "npx", "mise", "npm-global", "unknown"].includes(copy) ? { copy } : {},
      ...str(raw.version) ? { version: str(raw.version) } : {},
      ...raw.purpose === "sync" || raw.purpose === "compact" ? { purpose: raw.purpose } : {},
      ...raw.origin === "hook" || raw.origin === "command" ? { origin: raw.origin } : {}
    };
  } catch {
    return null;
  }
}
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}
function describeHolder(holder, now = Date.now()) {
  const { owner } = holder;
  if (!owner) return `a sync whose lock names no owner (last touched ${ago(now - holder.touchedAt.getTime())})`;
  const what = owner.purpose === "compact" ? "hook tidying its session log" : owner.origin === "hook" ? "background sync" : "sync";
  const label = `${whose(owner.copy)} ${what}`;
  const details = [
    owner.version ? `centrail ${owner.version}` : void 0,
    `pid ${owner.pid}`,
    holder.foreignHost && owner.host ? `on ${owner.host}` : void 0,
    owner.startedAt ? `started ${clock(new Date(owner.startedAt))}, ${ago(now - new Date(owner.startedAt).getTime())}` : void 0
  ].filter(Boolean);
  return `${label} (${details.join(", ")})`;
}
function heldMessage(holder, now = Date.now()) {
  if (!holder) return "Another sync is already running on this computer. Try again when it finishes.";
  const where = holder.foreignHost ? "on another computer sharing this config" : "on this computer";
  return `Another sync is already running ${where}: ${describeHolder(holder, now)}. Try again when it finishes.`;
}
function reclaimedMessage(holder, now = Date.now()) {
  const why = holder.owner && !holder.foreignHost ? "it is no longer running" : "it stopped updating its lock";
  return `Took over the sync lock left by ${describeHolder(holder, now)}: ${why}.`;
}
function whose(copy) {
  switch (copy) {
    case void 0:
      return "an older centrail's";
    // owner files before 0.10 name no copy
    case "unknown":
      return "another install's";
    case "npx":
      return "an npx run's";
    default:
      return `the ${copyLabel(copy)}'s`;
  }
}
function clock(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1e3));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min ago` : `${h} h ago`;
}

// src/commands/hook.ts
var AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1e3;
var SESSION_PREFIX = { "gemini-cli": "gemini:", pi: "pi:" };
var TRANSCRIPT_SURFACES = /* @__PURE__ */ new Set(["claude-code", "codex"]);
function hookReply(surface) {
  return surface === "codex" || surface === "gemini-cli" || surface === "copilot-cli" || surface === "cursor" ? "{}\n" : "";
}
function detectSurface(input, fallback) {
  if (typeof input.turn_id === "string" && input.turn_id) return "codex";
  const t = typeof input.transcript_path === "string" ? input.transcript_path.replace(/\\/g, "/") : "";
  if (/\/sessions\/.*rollout-[^/]*\.jsonl$/.test(t)) return "codex";
  return fallback;
}
var MAX_DIRS_PER_TURN = 64;
var MAX_BYTES_PER_TURN = 64 * 1024 * 1024;
async function runStopHook(raw, surface = "claude-code", deps = {}) {
  try {
    return await stopHook(raw, surface, deps);
  } catch {
    return null;
  }
}
async function stopHook(raw, surface, deps) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject11(input)) return null;
  const rawId = firstString(input.session_id, input.sessionId, surface === "cursor" ? input.conversation_id : void 0);
  const workspace = surface === "cursor" && Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
  const cwd = firstString(input.cwd, workspace[0]);
  if (!rawId || !cwd) return null;
  if (surface === "claude-code") surface = detectSurface(input, surface);
  const sessionId = `${SESSION_PREFIX[surface] ?? ""}${rawId}`;
  const now = deps.now ? deps.now() : /* @__PURE__ */ new Date();
  const root = await resolveRepoRoot(cwd);
  const repo = root ? await repoIdentity(root) : null;
  const head = root ? await readHeadState(root) : { branch: null, head: null };
  const line = {
    v: 1,
    ts: now.toISOString(),
    surface,
    sessionId,
    cwd,
    repo,
    root,
    branch: head.branch,
    head: head.head
  };
  const transcript = !TRANSCRIPT_SURFACES.has(surface) ? "" : typeof input.transcript_path === "string" ? input.transcript_path : "";
  const previous = (await readSidecar(deps.sidecarPath)).get(sessionId);
  const roots = { ...previous?.roots ?? {} };
  const mains = { ...previous?.mains ?? {} };
  if (root && repo) await recordRoot(root, repo, roots, mains);
  if (transcript) {
    line.transcript = transcript;
    line.offset = await recordTouchedRoots(transcript, previous?.offset ?? 0, roots, mains, cwd);
    const subOffsets = { ...previous?.subOffsets ?? {} };
    for (const sub of await subagentTranscripts(transcript)) {
      subOffsets[sub] = await recordTouchedRoots(sub, subOffsets[sub] ?? 0, roots, mains, cwd);
    }
    if (Object.keys(subOffsets).length > 0) line.subOffsets = subOffsets;
  }
  if (Object.keys(roots).length > 0) line.roots = roots;
  if (Object.keys(mains).length > 0) line.mains = mains;
  await appendSidecar(line, deps.sidecarPath);
  await maybeAutoSync(now, deps, deps.claimPath ?? join16(dirname9(deps.sidecarPath ?? SIDECAR_PATH), "autosync.claim"));
  return line;
}
async function subagentTranscripts(transcript) {
  if (!transcript.endsWith(".jsonl")) return [];
  const dir = join16(transcript.slice(0, -".jsonl".length), "subagents");
  try {
    return (await readdir7(dir)).filter((f) => f.endsWith(".jsonl")).map((f) => join16(dir, f));
  } catch {
    return [];
  }
}
async function recordRoot(root, id, roots, mains) {
  if (roots[root]) return;
  roots[root] = id;
  const main = await readMainCheckout(root);
  if (main) mains[root] = main;
}
async function recordTouchedRoots(transcript, offset, roots, mains, cwd) {
  let fh;
  try {
    fh = await open(transcript, "r");
  } catch {
    return offset;
  }
  try {
    const size = (await fh.stat()).size;
    if (size <= offset) return size < offset ? 0 : offset;
    const length = Math.min(size - offset, MAX_BYTES_PER_TURN);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    const complete = buf.subarray(0, bytesRead).lastIndexOf(10);
    if (complete < 0) return offset;
    const lines = [];
    let turnCwd = cwd;
    for (let start = 0; start <= complete; ) {
      const nl = buf.indexOf(10, start);
      const raw = buf.toString("utf-8", start, nl);
      start = nl + 1;
      if (!raw.includes('"tool_use"') && !raw.includes('"function_call"') && !raw.includes('"turn_context"')) continue;
      let line;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isObject11(line)) continue;
      let ev = null;
      if (line.type === "assistant" && isObject11(line.message)) ev = lineEvidence(line.message);
      else if (line.type === "turn_context" && isObject11(line.payload) && typeof line.payload.cwd === "string") turnCwd = line.payload.cwd;
      else if (line.type === "response_item" && isObject11(line.payload) && line.payload.type === "function_call") ev = codexCallEvidence(line.payload.name, line.payload.arguments, turnCwd);
      if (!ev) continue;
      lines.push({ paths: [...ev.writes, ...ev.reads], end: start });
    }
    let spawned = 0;
    const seen = /* @__PURE__ */ new Set();
    for (let i = 0; i < lines.length; i++) {
      for (const path of lines[i].paths) {
        const dir = await nearestDirectory(path);
        if (!dir || seen.has(dir)) continue;
        seen.add(dir);
        const known = deepestRoot(Object.keys(roots), path);
        if (known && !await nestedCheckout(known, dir)) continue;
        if (spawned++ >= MAX_DIRS_PER_TURN) return offset + (i > 0 ? lines[i - 1].end : lines[i].end);
        const r = await resolveRepoRoot(dir);
        if (!r) continue;
        const id = roots[r] ?? await repoIdentity(r);
        if (!id) continue;
        await recordRoot(r, id, roots, mains);
        const alias = logicalRoot(dir, r);
        if (alias && !roots[alias]) roots[alias] = id;
      }
    }
    return offset + complete + 1;
  } finally {
    await fh.close();
  }
}
function logicalRoot(dir, root) {
  let physical;
  try {
    physical = realpathSync4(dir);
  } catch {
    return null;
  }
  if (!isWithin(physical, root)) return null;
  const suffix = physical.slice(root.length);
  if (!dir.endsWith(suffix)) return null;
  const logical = dir.slice(0, dir.length - suffix.length);
  return logical && logical !== root ? logical : null;
}
function firstString(...values) {
  return values.find((v) => typeof v === "string" && v !== "") ?? "";
}
function isObject11(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
var CLOCK_STEP_MS = 60 * 1e3;
function shouldAutoSync(state, now) {
  if (!state.autoSyncAt) return true;
  const last = new Date(state.autoSyncAt).getTime();
  return Number.isNaN(last) || last - now.getTime() > CLOCK_STEP_MS || now.getTime() - last >= AUTO_SYNC_INTERVAL_MS;
}
async function maybeAutoSync(now, deps, claimPath) {
  const read = deps.readState ?? readState;
  const write = deps.writeState ?? writeState;
  const connected = deps.connected ?? (async () => await readAuth() !== null);
  const state = await read();
  if (!shouldAutoSync(state, now)) return;
  if (!await connected() || hookParked(state)) {
    if (await claimAutoSync(claimPath, now)) await compactLocked(now, deps);
    return;
  }
  if (!await claimAutoSync(claimPath, now)) return;
  state.autoSyncAt = now.toISOString();
  await write(state);
  (deps.spawnSync ?? spawnDetachedSync)();
}
async function compactLocked(now, deps) {
  const release = await acquireSyncLock(deps.lockPath ?? join16(dirname9(deps.sidecarPath ?? SIDECAR_PATH), "sync.lock"), { purpose: "compact" });
  if (!release) return;
  try {
    await compactSidecar(deps.sidecarPath, now.getTime());
  } finally {
    await release();
  }
}
async function claimAutoSync(claimPath, now) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir7(claimPath, { recursive: false });
      return true;
    } catch (err) {
      const code = err.code;
      if (code === "ENOENT") {
        await mkdir7(dirname9(claimPath), { recursive: true });
        continue;
      }
      if (code !== "EEXIST") return false;
      let at;
      try {
        at = (await stat12(claimPath)).mtimeMs;
      } catch {
        continue;
      }
      if (!shouldAutoSync({ autoSyncAt: new Date(at).toISOString() }, now)) return false;
      await rm5(claimPath, { recursive: true, force: true });
    }
  }
  return false;
}
function spawnDetachedSync() {
  const child = spawn3(process.execPath, [process.argv[1], "sync"], {
    detached: true,
    windowsHide: true,
    // a detached child on Windows has no console; each git it runs would open one
    stdio: "ignore",
    env: { ...process.env, CENTRAIL_SYNC_ORIGIN: "hook" }
    // named in the lock, so a second sync says whose it is
  });
  child.unref();
}

// src/commands/hooks-doctor.ts
import { constants as constants3 } from "node:fs";
import { access as access2 } from "node:fs/promises";
import { isAbsolute as isAbsolute4, win32 as win325 } from "node:path";
async function inspectUserHooks(claudePath = claudeSettingsPath(), codexPath = codexHooksPath()) {
  const findings = [];
  const errors = [];
  let claudePlugin = false;
  for (const [source, path] of [["Claude user settings", claudePath], ["Codex user hooks", codexPath]]) {
    let settings;
    try {
      settings = (await readSettingsFile(path)).settings;
    } catch {
      errors.push(`${source}: cannot read configuration`);
      continue;
    }
    if (source === "Claude user settings") claudePlugin = pluginEnabled(settings);
    const groups = Array.isArray(settings.hooks?.Stop) ? settings.hooks.Stop : [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) {
        if (handler?.type !== "command" || typeof handler.command !== "string") continue;
        const command2 = handler.command;
        const words = commandWords(command2);
        const pluginLauncher = /^\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}\/scripts\/(?:hook\.sh|centrail\.mjs)$/.test(words?.[1] ?? "");
        const owned = isCentrailCommand(command2);
        if (!owned && !pluginLauncher) continue;
        if (owned && /(?:^|[\\/])centrail-hook(?:\.cmd)?$/.test(words?.[0] ?? "")) {
          findings.push({ source, kind: "stable launcher", resolves: await isExecutable(words[0]) });
          continue;
        }
        const paths = words?.slice(0, 2) ?? [];
        const absolute2 = paths.length === 2 && paths.every((p) => isAbsolute4(p) || win325.isAbsolute(p));
        const resolves = !pluginLauncher && absolute2 && (await Promise.all(paths.map(async (p, i) => {
          try {
            await access2(p, i === 0 ? constants3.X_OK : constants3.R_OK);
            return true;
          } catch {
            return false;
          }
        }))).every(Boolean);
        findings.push({ source, kind: !owned ? "unattributed plugin launcher" : pluginLauncher ? "plugin launcher" : "pinned CLI", resolves });
      }
    }
  }
  const claudeCount = findings.filter((f) => f.source === "Claude user settings" && f.kind !== "unattributed plugin launcher").length + Number(claudePlugin);
  const codexCount = findings.filter((f) => f.source === "Codex user hooks" && f.kind !== "unattributed plugin launcher").length;
  return { claudePlugin, findings, errors, possibleDuplicates: claudeCount > 1 || codexCount > 1 };
}
async function runHooksDoctor(claudePath, codexPath, opts = {}) {
  const report = await inspectUserHooks(claudePath, codexPath);
  if (opts.json) {
    console.log(JSON.stringify({ version: 1, ...report }));
    return;
  }
  console.log("Centrail hook check \u2014 user installation files only (read-only)");
  console.log(`Claude user plugin setting: ${report.claudePlugin ? "enabled; plugin owns its launcher" : "disabled/absent; standalone hook expected"}`);
  for (const finding of report.findings) {
    console.log(`${finding.source}: ${finding.kind}; ${finding.resolves ? "executable and bundle resolve" : "unresolved or requires plugin context"}`);
  }
  for (const error of report.errors) console.log(error);
  console.log(`Possible duplicate user hooks: ${report.possibleDuplicates ? "yes" : "none found"}`);
  console.log("Generic plugin-root launchers have ambiguous ownership and are never removed automatically.");
  console.log("Active project/managed/TOML/plugin-cache hooks and trust are not verified here. Review Codex's hook inventory and Claude's /hooks; restart/reload after changes.");
}

// src/commands/doctor.ts
async function doctorReport(deps = {}) {
  const ins = await inspectIntegrations(deps);
  const plan = planSetup(ins);
  const agents = {};
  for (const agent of AGENTS) agents[agent] = agentReport(ins, agent, plan.find((p) => p.agent === agent).action);
  const state = await readState();
  const at = here(deps.script === void 0 ? void 0 : detectChannel(deps.script));
  const { outdated, notice } = liveVersionRecords(state, at, ins.claude.plugin.version);
  const notices = [
    ...outdated ? [{ copy: outdated.channel, kind: "below-minimum", line: `${copyLabel(outdated.channel)}: ${outdatedLine(outdated)}` }] : [],
    ...notice ? [{ copy: notice.channel, kind: "update-available", line: `${copyLabel(notice.channel)}: ${updateNoticeLine(notice)}` }] : []
  ];
  const latest = state.updateNotice?.latest ?? null;
  const needed = Object.values(agents).some((a) => a.usesLauncher);
  return {
    version: 2,
    // An available update is reported, not failed on: it needs no action to keep collecting.
    ok: Object.values(agents).every((a) => a.status === "ok" || a.status === "not-detected" || a.status === "not-supported") && !outdated,
    cli: { version: CLI_VERSION, copy: at.channel, latest, updateAvailable: latest !== null && isOlder(CLI_VERSION, latest) },
    launcher: { needed, present: ins.launcher.present, executable: ins.launcher.executable, resolvesCli: ins.launcher.resolvesCli },
    agents,
    notices
  };
}
function agentReport(ins, agent, fix) {
  const state = ins.agents[agent];
  const plugin = agent === "claude-code" ? ins.claude.plugin : null;
  const hooks = state.hooks;
  const usesLauncher = hooks.length ? hooks.every((h) => h.form === "launcher") : null;
  const commandResolves = hooks.length ? hooks.every((h) => h.resolves) && (!usesLauncher || ins.launcher.resolvesCli) : null;
  const integration = plugin?.enabled ? "plugin" : hooks.length ? "hook" : "none";
  const status2 = (() => {
    if (!state.detected) return "not-detected";
    if (!state.readable) return "unreadable";
    if (IDENTITY_ONLY.includes(agent) && hooks.length === 0) return "not-supported";
    if (plugin?.enabled) return fix === "ok" ? "ok" : "repair";
    if (hooks.length === 0) return "missing";
    if (hooks.length > 1) return "duplicate";
    if (!usesLauncher) return "outdated-pin";
    if (!commandResolves) return "unresolved";
    return hooks[0].current ? "ok" : "outdated";
  })();
  return {
    detected: state.detected,
    integration,
    plugin: plugin ? { enabled: plugin.enabled, autoUpdate: plugin.autoUpdate && plugin.release, version: plugin.version } : null,
    hooks: hooks.length,
    usesLauncher,
    commandResolves,
    usage: !IDENTITY_ONLY.includes(agent),
    status: status2,
    fix: status2 === "ok" || status2 === "not-detected" ? "ok" : status2 === "not-supported" ? "skip" : fix
  };
}
var SAY = {
  ok: "ok",
  "not-detected": "not detected",
  "not-supported": `${NOT_SUPPORTED}; nothing installed`,
  unreadable: "its hook file does not parse",
  missing: "not set up: no centrail hook or plugin",
  duplicate: "more than one centrail hook (turns would be recorded twice)",
  "outdated-pin": "outdated pinned command (breaks when Node or centrail moves)",
  outdated: "outdated entry: not what this centrail writes",
  unresolved: "hook does not resolve (its launcher or pinned paths are missing)",
  repair: "plugin installed, but auto-update is off or a standalone hook remains"
};
function printDoctor(r) {
  console.log("centrail doctor (read-only)");
  const latest = r.cli.latest ? `; latest known ${r.cli.latest}` : "";
  console.log(`  ${"centrail".padEnd(12)} ${r.cli.version} (${copyLabel(r.cli.copy)})${latest}`);
  for (const agent of AGENTS) {
    const a = r.agents[agent];
    const how = a.plugin?.enabled ? `plugin${a.plugin.version ? ` ${a.plugin.version}` : ""}, auto-update ${a.plugin.autoUpdate ? "on" : "off"}` : a.usesLauncher ? `${HOW[agent]} through the launcher` : a.hooks ? HOW[agent] : "";
    const only = a.usage || a.status === "not-supported" ? "" : " (repo identity only; usage not collected yet)";
    const status2 = `${a.status === "ok" ? `ok${how ? `: ${how}` : ""}` : SAY[a.status]}${a.status === "not-detected" ? "" : only}`;
    console.log(`  ${LABEL[agent].padEnd(12)} ${status2}`);
  }
  if (r.launcher.needed || r.launcher.present) {
    const l = r.launcher;
    const state = !l.present ? "missing" : !l.executable ? "not executable" : l.resolvesCli ? "ok: finds a centrail to run" : "finds no centrail, Node or npx to run";
    console.log(`  ${"launcher".padEnd(12)} ${state}`);
  }
  for (const n of r.notices) console.log(`  ${n.line}`);
  console.log("  Codex hook trust and project/managed hook layers are not checked here: review /hooks in each agent.");
  console.log(r.ok ? "Nothing needs action." : "Needs action: run `centrail doctor --fix` (or `centrail setup`).");
}
async function runDoctor(opts, deps = {}) {
  let report = await doctorReport(deps);
  if (opts.fix && !report.ok) {
    const agents = AGENTS.filter((a) => report.agents[a].fix !== "ok" && report.agents[a].fix !== "skip");
    if (agents.length) {
      const log = console.log;
      if (opts.json) console.log = (...a) => console.error(...a);
      try {
        await runIntegrationSetup({ agents, yes: true, interactive: opts.interactive }, deps);
      } finally {
        console.log = log;
      }
      report = await doctorReport(deps);
    }
  }
  if (opts.json) console.log(JSON.stringify(report));
  else printDoctor(report);
  if (!report.ok) process.exitCode = 1;
  return report;
}

// src/commands/upgrade.ts
import { spawn as spawn4 } from "node:child_process";
function upgradeStep(channel) {
  switch (channel) {
    case "mise":
      return { command: ["mise", "upgrade", "npm:centrail"], say: "mise installed this copy." };
    case "npm-global":
      return { command: ["npm", "i", "-g", "centrail@latest"], say: "A global npm install is this copy." };
    case "npx":
      return { command: null, say: "npx runs the newest release whenever it is invoked as `npx centrail@latest`; there is nothing to install." };
    case "plugin":
      return { command: null, say: "This copy is the Claude Code plugin's: run `/plugin marketplace update centrail` in Claude Code (it also updates itself when auto-update is on)." };
    default:
      return { command: null, say: `Cannot tell how this copy was installed: ${howToUpdate(channel)}.` };
  }
}
async function runUpgrade(opts, deps = {}) {
  const channel = deps.channel ?? detectChannel(deps.script);
  const step = upgradeStep(channel);
  console.log(step.say);
  let ran = null;
  if (step.command) {
    const shown = step.command.join(" ");
    if (!opts.yes) {
      if (!opts.interactive) {
        console.log(`Run \`${shown}\`, or \`centrail upgrade -y\` to let centrail run it.`);
        return { ran: null, refreshed: false };
      }
      const reply = (await (deps.ask ?? askLine)(`  Run \`${shown}\` now? [Y/n] `))?.trim().toLowerCase();
      if (reply === void 0 || reply !== "" && !reply.startsWith("y")) {
        console.log("Nothing changed.");
        return { ran: null, refreshed: false };
      }
    }
    const code = await (deps.run ?? runInherit)(step.command);
    if (code !== 0) throw new Error(`\`${shown}\` exited with ${code}; nothing else changed.`);
    ran = step.command;
  } else if (channel !== "npx") {
    return { ran: null, refreshed: false };
  }
  const refreshed = await refreshLauncher(deps);
  if (refreshed) console.log("\u2713 Refreshed the hook launcher.");
  return { ran, refreshed };
}
async function refreshLauncher(deps = {}) {
  const ins = await inspectIntegrations(deps);
  if (await readLauncher(ins.launcher.path) === null) return false;
  return writeLauncher(ins.expected, ins.launcher.path);
}
function runInherit(command2) {
  return new Promise((resolve) => {
    const child = spawn4(command2[0], command2.slice(1), { stdio: "inherit", shell: process.platform === "win32", windowsHide: true });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

// src/commands/import.ts
import { readFile as readFile15 } from "node:fs/promises";
var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
var MAX_MODEL = 100;
function parseCcusageExport(json) {
  if (!isObject12(json)) throw new Error("Not a ccusage export: expected a JSON object");
  const merged = /* @__PURE__ */ new Map();
  const add = (day, breakdown) => {
    if (!isObject12(breakdown)) throw new Error("Not a ccusage export: a model breakdown is not an object");
    if (typeof breakdown.modelName !== "string" || !breakdown.modelName) throw new Error("Not a ccusage export: a model breakdown has no modelName");
    const model = breakdown.modelName.slice(0, MAX_MODEL);
    const key = `${day}\0${model}`;
    const row = merged.get(key) ?? { day, model, inputTokens: 0, outputTokens: 0, contextTokens: 0 };
    row.inputTokens += count2(breakdown.inputTokens);
    row.outputTokens += count2(breakdown.outputTokens);
    row.contextTokens += count2(breakdown.cacheReadTokens) + count2(breakdown.cacheCreationTokens);
    merged.set(key, row);
  };
  if (Array.isArray(json.daily)) {
    for (const d of json.daily) {
      if (!isObject12(d) || typeof d.date !== "string" || !DAY_RE.test(d.date)) throw new Error("Not a ccusage export: a daily row has no YYYY-MM-DD date");
      for (const b of Array.isArray(d.modelBreakdowns) ? d.modelBreakdowns : []) add(d.date, b);
    }
  } else if (Array.isArray(json.sessions)) {
    for (const s of json.sessions) {
      if (!isObject12(s) || typeof s.lastActivity !== "string" || Number.isNaN(Date.parse(s.lastActivity))) throw new Error("Not a ccusage export: a session has no lastActivity");
      const day = new Date(s.lastActivity).toISOString().slice(0, 10);
      for (const b of Array.isArray(s.modelBreakdowns) ? s.modelBreakdowns : []) add(day, b);
    }
  } else {
    throw new Error("Not a ccusage export: expected `daily` (ccusage claude daily --json) or `sessions` (ccusage claude session --json)");
  }
  return [...merged.values()];
}
function count2(v) {
  if (v === void 0 || v === null) return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error("Not a ccusage export: a token count is not a non-negative integer");
  return v;
}
async function runImport(file, deps = {}) {
  const auth = await readAuth();
  if (!auth) throw new Error("Not connected \u2014 run `centrail connect` first");
  assertSecureBaseUrl(auth.baseUrl);
  let json;
  try {
    json = JSON.parse(await readFile15(file, "utf-8"));
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }
  const rows = parseCcusageExport(json);
  if (rows.length === 0) {
    console.log("Nothing to import: the file has no usage rows.");
    return;
  }
  const res = await (deps.fetch ?? fetch)(`${auth.baseUrl}/api/import`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${auth.token}`, ...versionHeaders() },
    body: JSON.stringify({ provider: "ccusage", rows })
  });
  if (res.status === 401) throw new Error("Token revoked or expired \u2014 run `centrail connect`");
  if (!res.ok) {
    const b = await res.json().catch(() => null);
    throw new Error(`Import failed (${res.status})${b?.error ? `: ${b.error}` : ""}`);
  }
  const days = new Set(rows.map((r) => r.day));
  console.log(`Imported ${rows.length} day\xB7model row(s) over ${days.size} day(s) as Measured history (provider ccusage). A re-import replaces them.`);
}
function isObject12(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// src/device.ts
async function checkDevice(auth) {
  try {
    const res = await fetch(`${auth.baseUrl}/api/cli/device`, {
      headers: { authorization: `Bearer ${auth.token}`, ...versionHeaders() },
      signal: AbortSignal.timeout(5e3)
    });
    if (res.status === 401) return { kind: "refused", reason: await refusalReason(res) };
    if (!res.ok) return { kind: "unknown" };
    const body = await res.json();
    const email = body.account?.email;
    const pairedAt = body.device?.pairedAt;
    return {
      kind: "active",
      ...typeof email === "string" && email ? { account: { email } } : {},
      ...typeof pairedAt === "string" ? { pairedAt } : {}
    };
  } catch {
    return { kind: "unknown" };
  }
}
async function refusalReason(res) {
  const body = await res.json().catch(() => null);
  return body?.code === "device_revoked" || body?.code === "unknown_token" ? body.code : "unauthorized";
}

// src/commands/status.ts
async function runStatus() {
  const auth = await readAuth();
  if (!auth) {
    const parked = await readDisconnected();
    console.log(parked ? disconnectedMessage(parked) : "Not connected. Run `npx centrail connect` to pair this machine.");
    process.exitCode = 1;
    return;
  }
  const device = await checkDevice(auth);
  if (device.kind === "refused") {
    await parkAuth(device.reason);
    console.log(disconnectedMessage({ at: (/* @__PURE__ */ new Date()).toISOString(), reason: device.reason }));
    process.exitCode = 1;
    return;
  }
  const host = new URL(auth.baseUrl).host;
  const email = (device.kind === "active" ? device.account?.email : void 0) ?? auth.account?.email;
  const paired = device.kind === "active" && device.pairedAt ? ` \xB7 paired ${device.pairedAt.slice(0, 10)}` : "";
  const unconfirmed = device.kind === "unknown" ? " (the server could not confirm it just now)" : "";
  console.log(`Connected to ${host}${email ? ` as ${email}` : ""}${paired}${unconfirmed}`);
  await printVersionRecords();
}
async function printVersionRecords() {
  const state = await readState();
  const at = here();
  console.log(`This command ran centrail ${at.version} (${copyLabel(at.channel)}).`);
  const { outdated, notice } = liveVersionRecords(state, at, await installedPluginVersion());
  if (outdated) console.log(`${copyLabel(outdated.channel)}: ${outdatedLine(outdated)}`);
  if (notice) console.log(`${copyLabel(notice.channel)}: ${updateNoticeLine(notice)}`);
}

// src/fate-memo.ts
import { mkdir as mkdir8, readFile as readFile16, writeFile as writeFile7 } from "node:fs/promises";
import { join as join17 } from "node:path";
var MEMO_PATH = join17(CONFIG_DIR, "fate-facts.json");
var VERSION = 1;
var KEEP_MS = 14 * 24 * 60 * 60 * 1e3;
function memoKey(commonDir, defaultBranch, withPatchIds) {
  return `${commonDir}\0${defaultBranch}\0${withPatchIds ? "patch-id" : ""}`;
}
var utcDay = (d) => d.toISOString().slice(0, 10);
async function loadFactsMemo(path = MEMO_PATH) {
  let entries = {};
  try {
    const raw = JSON.parse(await readFile16(path, "utf-8"));
    if (raw.version === VERSION && raw.entries && typeof raw.entries === "object") entries = raw.entries;
  } catch {
  }
  let dirty = false;
  return {
    get(key, digest, now) {
      const e = entries[key];
      if (!e || e.digest !== digest || e.day !== utcDay(now) || !e.facts || !Array.isArray(e.facts.shas)) return void 0;
      e.usedAt = now.toISOString();
      dirty = true;
      return { ...e.facts, now: now.toISOString() };
    },
    set(key, digest, now, facts) {
      entries[key] = { digest, day: utcDay(now), usedAt: now.toISOString(), facts };
      dirty = true;
    },
    async save() {
      if (!dirty) return;
      const cutoff = Date.now() - KEEP_MS;
      for (const [k, e] of Object.entries(entries)) if (!(Date.parse(e.usedAt) >= cutoff)) delete entries[k];
      try {
        await mkdir8(join17(path, ".."), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        await writeFile7(tmp, JSON.stringify({ version: VERSION, entries }), { mode: 384 });
        await replaceFile(tmp, path);
        dirty = false;
      } catch {
      }
    }
  };
}

// src/progress.ts
var mode = "auto";
var inline = false;
var status = null;
var heartbeat = null;
var HEARTBEAT_MS = 1e3;
var REDRAW_MS = 100;
function setProgressMode(next) {
  mode = next;
}
function progressEnabled(env = process.env, isTTY = process.stderr.isTTY === true) {
  if (mode === "quiet") return false;
  if (mode === "verbose") return true;
  return isTTY && !env.CI;
}
function progress(message) {
  if (!progressEnabled()) return;
  if (inline) process.stderr.write("\r\x1B[K");
  inline = false;
  stopStatus();
  process.stderr.write(`  ${message}
`);
}
function progressDetail(message) {
  if (mode === "verbose") progress(message);
}
function progressStatus(message) {
  if (!progressEnabled()) return;
  const now = Date.now();
  const tty = process.stderr.isTTY === true;
  const phase = message.replace(/\d[\d,]*/g, "#");
  if (status?.phase === phase) {
    status.message = message;
    if (now - status.drawnAt < (tty ? REDRAW_MS : HEARTBEAT_MS)) return;
  } else {
    status = { message, phase, since: now, drawnAt: 0 };
  }
  status.drawnAt = now;
  if (!tty) {
    process.stderr.write(`  ${message}
`);
    return;
  }
  drawStatus(now);
  if (!heartbeat) {
    heartbeat = setInterval(() => drawStatus(Date.now()), HEARTBEAT_MS);
    heartbeat.unref();
  }
}
function progressDone() {
  if (inline && progressEnabled()) process.stderr.write("\r\x1B[K");
  inline = false;
  stopStatus();
}
function drawStatus(now) {
  if (!status) return;
  const secs = Math.floor((now - status.since) / 1e3);
  const age = secs < 1 ? "" : secs < 60 ? ` \xB7 ${secs}s` : ` \xB7 ${Math.floor(secs / 60)}m ${secs % 60}s`;
  process.stderr.write(`\r\x1B[K  ${status.message}${age}`);
  inline = true;
}
function stopStatus() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  status = null;
}

// src/placer.ts
var Placer = class {
  constructor(resolver) {
    this.resolver = resolver;
  }
  async place(events) {
    const sessions = /* @__PURE__ */ new Map();
    for (const e of events) {
      this.resolver.fixBranch(e);
      if (e.metadata.repo) continue;
      const sid = e.metadata.sessionId;
      if (!sid || !e.metadata.turn) {
        await this.resolver.stamp(e);
        continue;
      }
      let list = sessions.get(sid);
      if (!list) sessions.set(sid, list = []);
      list.push(e);
    }
    for (const list of sessions.values()) await this.placeSession(list);
  }
  async placeSession(events) {
    events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const turns = /* @__PURE__ */ new Map();
    for (const e of events) {
      const id = e.metadata.turn;
      let t = turns.get(id);
      if (!t) turns.set(id, t = []);
      t.push(e);
    }
    let sticky = null;
    for (const turn of turns.values()) {
      const base = await this.resolver.identityFor(turn[0]);
      let repo = null;
      let placement = null;
      if (base && base.source !== "folder") {
        repo = base;
        placement = "cwd";
      } else {
        const evidence = turn.reduce((acc, e) => merge(acc, e.metadata.touched), { writes: [], reads: [] });
        const byFiles = await this.namedRepo(evidence.writes, turn[0]) ?? await this.namedRepo(evidence.reads, turn[0]);
        if (byFiles) {
          repo = byFiles;
          placement = "files";
        } else if (sticky) {
          repo = sticky;
          placement = "sticky";
        } else if (base) {
          repo = base;
          placement = "folder";
        }
      }
      if (repo && placement) {
        for (const e of turn) {
          e.metadata.repo = repo;
          e.metadata.placement = placement;
        }
        if (placement !== "folder") sticky = repo;
      }
    }
  }
  // The one repo a set of paths names: the identity most of them fall
  // under, so two repos in one turn (unmeasured, never observed) yield a
  // home and not a split. Null when none of the paths is in a repo.
  async namedRepo(paths, e) {
    const votes = /* @__PURE__ */ new Map();
    for (const path of paths) {
      const repo = await this.resolver.identityForPath(path, e.metadata.sessionId);
      if (!repo) continue;
      const v = votes.get(repo.key);
      if (v) v.n++;
      else votes.set(repo.key, { repo, n: 1 });
    }
    let best = null;
    for (const v of votes.values()) if (!best || v.n > best.n) best = v;
    return best?.repo ?? null;
  }
};
function merge(a, b) {
  if (!b) return a;
  return { writes: [.../* @__PURE__ */ new Set([...a.writes, ...b.writes])], reads: [.../* @__PURE__ */ new Set([...a.reads, ...b.reads])] };
}

// src/wire.ts
import { createHmac as createHmac2 } from "node:crypto";
function toWireUsageEvent(event) {
  return {
    externalId: event.externalId,
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheCreationTokens: event.cacheCreationTokens,
    ...event.cacheWriteTokens === void 0 ? {} : { cacheWriteTokens: event.cacheWriteTokens },
    cacheCreation5mTokens: event.cacheCreation5mTokens,
    cacheCreation1hTokens: event.cacheCreation1hTokens,
    occurredAt: event.occurredAt.toISOString()
  };
}
function consentedCapabilities(served, cfg) {
  return cfg.scopeDecidedAt ? served : { fields: /* @__PURE__ */ new Set() };
}
async function readCapabilities(auth, known) {
  const fallback = known ?? { fields: /* @__PURE__ */ new Set() };
  try {
    const res = await fetch(`${auth.baseUrl}/api/cli/capabilities`, {
      headers: versionHeaders(),
      signal: AbortSignal.timeout(5e3)
    });
    if (!res.ok) return fallback;
    const body = await res.json();
    const fields = Array.isArray(body.fields) ? body.fields.filter((f) => typeof f === "string") : [];
    const cli = parseCliVersions(body.cli);
    const surfaces = Array.isArray(body.surfaces) ? new Set(body.surfaces.filter((s) => typeof s === "string")) : void 0;
    return { fields: new Set(fields), ...surfaces ? { surfaces } : {}, ...cli ? { cli } : {} };
  } catch {
    return fallback;
  }
}
var BILLING_PROVIDERS = ["anthropic", "openai", "google", "openrouter", "amazon-bedrock", "google-vertex", "azure", "openai-codex", "github-copilot", "unknown"];
function billingProvider(event, surface) {
  if (surface === "gemini-cli") return "unknown";
  return BILLING_PROVIDERS.includes(event.provider) ? event.provider : "unknown";
}
function toWireEvent(e, caps, cfg, installId, surface) {
  const wire = toWireUsageEvent(e);
  if (caps.fields.has("usage-extras")) {
    if (e.speed) wire.speed = e.speed;
    if (e.webSearchRequests) wire.webSearchRequests = e.webSearchRequests;
  }
  if (caps.fields.has("repo")) wire.metadata = identityMetadata(e, cfg, installId);
  if ((surface === "pi" || surface === "gemini-cli") && caps.fields.has("billing-route")) {
    wire.billingProvider = billingProvider(e, surface);
    if (e.serviceClass !== void 0) {
      wire.serviceClass = ["standard", "priority", "flex", "batch", "unknown"].includes(e.serviceClass) ? e.serviceClass : "unknown";
    }
  }
  return wire;
}
function identityMetadata(e, cfg, installId) {
  const metadata = { origin: { machineId: installId } };
  if (e.metadata.repo) {
    metadata.repo = wireIdentity(redactIdentity(e.metadata.repo, cfg, installId));
    if (e.metadata.placement) metadata.placement = e.metadata.placement;
  }
  if (e.metadata.sessionId) metadata.sessionId = e.metadata.sessionId;
  const branch = wireBranch(e.metadata.gitBranch, cfg);
  if (branch) metadata.gitBranch = branch;
  return metadata;
}
function wireIdentity(repo) {
  return { key: repo.key, label: repo.label, source: repo.source, ...repo.root ? { root: repo.root } : {} };
}
function redactIdentity(repo, cfg, installId) {
  if (!cfg.hideRepoNames) return repo;
  if (repo.source === "folder") return { key: repo.key, label: "", source: repo.source };
  const digest = createHmac2("sha256", installId).update(repo.key).digest("hex").slice(0, 16);
  return { key: `hidden:${digest}`, label: "", source: repo.source };
}
function wireRepoRef(repo, cfg, installId) {
  const shown = redactIdentity(repo, cfg, installId);
  return { name: shown.label || shown.key, key: shown.key };
}
function wireBranch(branch, cfg) {
  return branch && !cfg.hideBranchNames ? branch : null;
}
function toWireFate(f, caps, cfg = { hideBranchNames: false }) {
  const repo = caps.fields.has("repo");
  const wire = {
    repoName: f.repoName,
    ...repo && f.repoKey ? { repoKey: f.repoKey } : {},
    commitSha: f.row.sha,
    branch: wireBranch(f.row.branch, cfg),
    fate: f.row.fate
  };
  if (repo) {
    if (f.row.mergedAs) wire.mergedAs = f.row.mergedAs;
    wire.committedAt = f.commit?.committedAt ?? "";
    wire.linesAdded = f.commit?.linesAdded ?? 0;
    wire.linesDeleted = f.commit?.linesDeleted ?? 0;
    wire.filesChanged = f.commit?.filesChanged ?? 0;
    if (f.mine !== void 0) wire.mine = f.mine;
  }
  if (caps.fields.has("patch-id")) {
    if (f.patchId) wire.patchId = f.patchId;
    if (f.branchPatchId) wire.branchPatchId = f.branchPatchId;
  }
  return wire;
}

// src/ship-status.ts
var FATE_CHUNK = 2e3;
var WINDOW_DAYS = 90;
var DAY_MS2 = 24 * 60 * 60 * 1e3;
async function gatherShipStatusFacts(repoRoot, now = /* @__PURE__ */ new Date(), withPatchIds = false) {
  const defaultBranch = await resolveDefaultBranch(repoRoot);
  if (!defaultBranch) return null;
  const shas = await listRecentShas(repoRoot, WINDOW_DAYS);
  const recent = new Set(shas.map((s) => s.sha));
  const cutoffMs = now.getTime() - WINDOW_DAYS * DAY_MS2;
  const ancestryRef = await resolveAncestryRef(repoRoot, defaultBranch);
  const ancestorShas = (await listReachableShas(repoRoot, ancestryRef, WINDOW_DAYS)).filter((sha) => recent.has(sha));
  const ancestors = new Set(ancestorShas);
  const isDefaultRef = (b) => b === defaultBranch || b === `origin/${defaultBranch}`;
  const branchesBySha = {};
  const branchTipDates = {};
  const cherryCandidates = [];
  for (const tip of await listBranchTips(repoRoot)) {
    const tipMs = tip.tipDate ? Date.parse(tip.tipDate) : Number.NaN;
    if (Number.isFinite(tipMs) && tipMs < cutoffMs) continue;
    branchTipDates[tip.name] = tip.tipDate;
    let unmerged = false;
    for (const sha of await listReachableShas(repoRoot, tip.ref, WINDOW_DAYS)) {
      if (!recent.has(sha)) continue;
      (branchesBySha[sha] ??= []).push(tip.name);
      if (!ancestors.has(sha)) unmerged = true;
    }
    if (unmerged && !isDefaultRef(tip.name)) cherryCandidates.push(tip);
  }
  const tips = /* @__PURE__ */ new Map();
  for (const tip of cherryCandidates) if (!tips.has(tip.sha)) tips.set(tip.sha, tip);
  const cherrySet = /* @__PURE__ */ new Set();
  const prefixes = [];
  for (const tip of tips.values()) {
    for (const sha of await cherryEquivalentShas(repoRoot, defaultBranch, tip.name)) {
      cherrySet.add(sha);
    }
    const prefix = await branchPrefixes(repoRoot, ancestryRef, tip.ref);
    if (prefix.length > 0) prefixes.push(prefix);
  }
  const committedMs = new Map(shas.map((c) => [c.sha, Date.parse(c.committedAt)]));
  const candidates = prefixes.map((prefix) => {
    const since = Date.parse(prefix[0].at);
    return ancestorShas.filter((sha) => (committedMs.get(sha) ?? -Infinity) >= since).reverse().slice(0, SQUASH_CANDIDATE_CAP);
  });
  const own = withPatchIds ? shas.map((c) => c.sha) : [...new Set(candidates.flat())];
  const ownIds = await patchIds(repoRoot, own.map((sha) => ({ sha })));
  const cumulative = new Map(prefixes.flat().map((c) => [c.sha, c.base]));
  const prefixIds = await patchIds(repoRoot, [...cumulative].map(([sha, base]) => ({ sha, base })));
  const squashedInto = {};
  prefixes.forEach((prefix, i) => {
    for (const [sha, into] of Object.entries(matchSquash(prefix, candidates[i], ownIds, prefixIds))) {
      if (recent.has(sha)) squashedInto[sha] = into;
    }
  });
  const branchPatchIds = {};
  for (const [sha, id] of Object.entries(prefixIds)) {
    if (recent.has(sha) && !ancestors.has(sha)) branchPatchIds[sha] = id;
  }
  return {
    defaultBranch,
    shas,
    ancestorShas,
    cherryEquivalentShas: [...cherrySet],
    squashedInto,
    branchesBySha,
    branchTipDates,
    now: now.toISOString(),
    patchIds: withPatchIds ? ownIds : {},
    branchPatchIds
  };
}
function matchSquash(prefix, candidates, own, cumulative) {
  const byId = /* @__PURE__ */ new Map();
  for (const sha of candidates) {
    const id = own[sha];
    if (id) byId.set(id, sha);
  }
  for (let k = prefix.length; k >= 1; k--) {
    const id = cumulative[prefix[k - 1].sha];
    const into = id ? byId.get(id) : void 0;
    if (into) return Object.fromEntries(prefix.slice(0, k).map((c) => [c.sha, into]));
  }
  return {};
}
async function runFatePass(auth, repos, declared = [], machineId, caps = { fields: new Set(machineId ? ["repo"] : []) }, cfg = { hideBranchNames: false }, memo) {
  let anyRepoPassed = false;
  const tally = { shipped: 0, inFlight: 0, unshipped: 0 };
  for (const [i, { root: one, roots: many, name, key }] of repos.entries()) {
    progressStatus(`Checking ship status \u2014 ${i + 1}/${repos.length} repos`);
    const roots = many ?? (one ? [one] : []);
    const facts = await gatherShipStatusFactsForRoots(roots, caps.fields.has("patch-id"), memo);
    if (!facts) continue;
    anyRepoPassed = true;
    const root = roots[0];
    const email = await readUserEmail(root);
    const bySha = new Map(facts.shas.map((c) => [c.sha, c]));
    const ancestors = new Set(facts.ancestorShas);
    const rows = computeCommitFates(facts);
    const fates = [];
    for (const row of rows) {
      if (row.fate === "shipped") tally.shipped++;
      else if (row.fate === "in_flight") tally.inFlight++;
      else tally.unshipped++;
      const commit = bySha.get(row.sha);
      fates.push(
        toWireFate(
          {
            repoName: name,
            repoKey: key,
            row,
            commit,
            mine: email && commit?.authorEmail ? commit.authorEmail === email : void 0,
            patchId: facts.patchIds[row.sha],
            branchPatchId: ancestors.has(row.sha) ? void 0 : facts.branchPatchIds[row.sha]
          },
          caps,
          cfg
        )
      );
    }
    const own = declared.filter((r) => key && r.key === key || r.name === name);
    await pushFates(auth, fates, own, machineId ? { machineId, complete: facts.complete } : void 0);
  }
  if (!anyRepoPassed) return null;
  return tally;
}
async function gatherShipStatusFactsForRoots(roots, withPatchIds = false, memo) {
  let merged = null;
  const gathered = /* @__PURE__ */ new Set();
  for (const root of roots) {
    const now = /* @__PURE__ */ new Date();
    let f;
    if (memo) {
      const [common, defaultBranch] = await Promise.all([readCommonDir(root), resolveDefaultBranch(root)]);
      if (!defaultBranch) continue;
      const key = common ? memoKey(common, defaultBranch, withPatchIds) : void 0;
      if (key && gathered.has(key)) continue;
      const digest = key && common ? await readRefsDigest(root, common) : null;
      f = key && digest ? memo.get(key, digest, now) : void 0;
      if (!f) {
        f = await gatherShipStatusFacts(root, now, withPatchIds);
        if (f && key && digest && await readRefsDigest(root, common) === digest) memo.set(key, digest, now, f);
      }
      if (key) gathered.add(key);
    } else {
      f = await gatherShipStatusFacts(root, now, withPatchIds);
    }
    if (!f) continue;
    const complete = f.shas.length < RECENT_SHA_CAP;
    if (!merged) {
      merged = { ...f, complete };
      continue;
    }
    const seen = new Set(merged.shas.map((c) => c.sha));
    for (const c of f.shas) if (!seen.has(c.sha)) merged.shas.push(c);
    merged.ancestorShas = [.../* @__PURE__ */ new Set([...merged.ancestorShas, ...f.ancestorShas])];
    merged.cherryEquivalentShas = [.../* @__PURE__ */ new Set([...merged.cherryEquivalentShas, ...f.cherryEquivalentShas])];
    merged.squashedInto = { ...merged.squashedInto ?? {}, ...f.squashedInto ?? {} };
    merged.patchIds = { ...merged.patchIds, ...f.patchIds };
    merged.branchPatchIds = { ...merged.branchPatchIds, ...f.branchPatchIds };
    for (const [sha, branches] of Object.entries(f.branchesBySha)) {
      merged.branchesBySha[sha] = [.../* @__PURE__ */ new Set([...merged.branchesBySha[sha] ?? [], ...branches])];
    }
    for (const [b, d] of Object.entries(f.branchTipDates)) if (!(b in merged.branchTipDates)) merged.branchTipDates[b] = d;
    merged.complete = merged.complete && complete;
  }
  return merged;
}
async function pushFates(auth, fates, repos, facts) {
  if (fates.length === 0) return;
  try {
    for (let i = 0; i < fates.length; i += FATE_CHUNK) {
      const chunk = fates.slice(i, i + FATE_CHUNK);
      const res = await fetch(`${auth.baseUrl}/api/cli/attribute`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${auth.token}`,
          ...versionHeaders()
        },
        body: JSON.stringify({ repos, attributions: [], fates: chunk, ...facts ? { facts } : {} })
      });
      if (res.status === 426) throw new CliOutdatedError(await parkOutdated(await minimumFrom(res)));
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        console.warn(
          `  \u26A0 Ship-status chunk skipped (${res.status})${body?.error ? `: ${body.error}` : ""}.`
        );
      }
    }
  } catch (err) {
    if (err instanceof CliOutdatedError) throw err;
    console.warn("  \u26A0 Ship-status request failed:", err.message);
  }
}
function formatShipStatusLine(tally) {
  return `ship status: ${tally.shipped} shipped / ${tally.inFlight} in flight / ${tally.unshipped} unshipped`;
}

// src/commands/sync.ts
var BATCH_SIZE = 250;
var RESEND_ON_GAIN = ["repo", "usage-extras"];
var WATERMARK_OVERLAP_MS = 24 * 60 * 60 * 1e3;
async function runSync(opts) {
  const lock = await claimSyncLock();
  if (!("release" in lock)) {
    console.log(heldMessage(lock.held));
    return;
  }
  if (lock.reclaimed) console.log(reclaimedMessage(lock.reclaimed));
  try {
    await syncLocked(opts);
  } finally {
    await lock.release();
  }
}
function summaryLines(t) {
  const n = (v) => v.toLocaleString("en-US");
  const head = `Inserted ${n(t.inserted)} \xB7 Skipped ${n(t.skipped)}` + // Projects are optional (2026-10 IA): a neutral count, not a queue to work.
  (t.inbox > 0 ? ` \xB7 ${n(t.inbox)} not in a project` : "") + (t.heldByScope > 0 ? ` \xB7 ${n(t.heldByScope)} held back by scope` : "");
  const sent = t.surfaces.filter((s) => s.inserted + s.skipped > 0);
  const width = Math.max(0, ...sent.map((s) => s.surface.length));
  return [head, ...sent.map((s) => `  ${s.surface.padEnd(width)}  inserted ${n(s.inserted)} \xB7 skipped ${n(s.skipped)}`)];
}
async function syncLocked(opts) {
  const auth = await readAuth();
  if (!auth) {
    const parked = await readDisconnected();
    throw new Error(parked ? disconnectedMessage(parked) : "Not connected \u2014 run `centrail connect` first");
  }
  assertSecureBaseUrl(auth.baseUrl);
  const device = await checkDevice(auth);
  if (device.kind === "refused") await disconnect(device.reason);
  progress(`Syncing to ${new URL(auth.baseUrl).host}${accountLabel(auth, device.kind === "active" ? device.account : void 0)}`);
  let config = await readConfig();
  if (!config.scopeDecidedAt) {
    if (isInteractiveTerminal()) {
      console.log("  Choose what syncs before any repo name leaves this machine (asked once).");
      await runSetup({ interactive: true });
      config = await readConfig();
    } else {
      console.log(SCOPE_UNANSWERED);
    }
  }
  const state = await readState();
  const installId = await ensureInstallId();
  const known = state.capabilities;
  const served = await readCapabilities(auth, known ? { fields: new Set(known) } : void 0);
  const caps = consentedCapabilities(served, config);
  const capsNow = [...served.fields].sort();
  const at = here();
  const versionsChanged = settleVersions(state, served.cli, at);
  if (config.scopeDecidedAt && known && RESEND_ON_GAIN.some((f) => served.fields.has(f) && !known.includes(f)) && !config.pendingBackfill) {
    config.pendingBackfill = true;
    await writeConfig(config);
  }
  if (versionsChanged || !known || JSON.stringify(capsNow) !== JSON.stringify(known)) {
    state.capabilities = capsNow;
    await writeState(state);
  }
  if (served.cli?.minimum && isOlder(at.version, served.cli.minimum)) throw new CliOutdatedError(await parkOutdated(served.cli.minimum));
  const notice = state.updateNotice?.version === at.version ? state.updateNotice : void 0;
  await compactSidecar().catch(() => {
  });
  await learnConfigDirs();
  const resolver = await IdentityResolver.create(installId);
  const placer = new Placer(resolver);
  const minOccurredAt = /* @__PURE__ */ new Date("2020-01-01T00:00:00.000Z");
  const maxOccurredAt = new Date(Date.now() + 24 * 60 * 60 * 1e3);
  let grandInserted = 0;
  let grandSkipped = 0;
  let grandInbox = 0;
  let grandHeldElsewhere = 0;
  let heldOnFullRead = 0;
  const surfaces = [];
  const took = { reading: 0, placing: 0, sending: 0, commits: 0 };
  const since0 = () => performance.now();
  let anyEvents = false;
  let anyWatermark = false;
  let heldByScope = 0;
  const attributionEvents = [];
  const full = opts.full || config.pendingBackfill;
  for (const scanner of SCANNERS) {
    if (!surfaceEnabled(config, scanner.surface)) continue;
    if (scanner.requiresSurfaceCapability && (!caps.surfaces?.has(scanner.surface) || !caps.fields.has("billing-route"))) {
      progress(`${scanner.surface}: waiting for server support; local logs were not read`);
      continue;
    }
    const mark = full ? void 0 : sinceForSurface(state, scanner.surface, scanner.revision);
    if (mark) anyWatermark = true;
    const since = mark ? new Date(mark.getTime() - WATERMARK_OVERLAP_MS) : void 0;
    const scanStartedAt = /* @__PURE__ */ new Date();
    const reading = `${scanner.surface}: reading logs ${since ? `since ${since.toISOString().slice(0, 10)}` : "(full history)"}`;
    progressStatus(`${reading}\u2026`);
    let t0 = since0();
    const scanned = await scanner.scan({
      since,
      wholeFiles: true,
      onFile: (done, total) => progressStatus(`${reading} \u2014 ${done.toLocaleString("en-US")}/${total.toLocaleString("en-US")} files`)
    });
    took.reading += since0() - t0;
    const candidates = scanned.filter(
      (e) => e.externalId.length > 0 && e.occurredAt >= minOccurredAt && e.occurredAt <= maxOccurredAt
    );
    progressStatus(`${scanner.surface}: finding the repo of ${scanned.length.toLocaleString("en-US")} events\u2026`);
    t0 = since0();
    await placer.place(scanned);
    took.placing += since0() - t0;
    const events = candidates.filter((e) => eventInScope(e, config));
    heldByScope += candidates.length - events.length;
    if (events.length === 0) {
      progress(`${scanner.surface}: nothing new${candidates.length > 0 ? ` (${candidates.length.toLocaleString("en-US")} held back by scope)` : ""}`);
      await stampSurface(state, scanner.surface, scanner.revision, scanStartedAt);
      continue;
    }
    anyEvents = true;
    if (scanner.surface === "claude-code" || scanner.surface === "codex") {
      for (const e of events) attributionEvents.push(e);
    }
    let surfaceInserted = 0;
    let surfaceSkipped = 0;
    let surfaceHeld = 0;
    t0 = since0();
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);
      progressStatus(`${scanner.surface}: sending ${Math.min(i + BATCH_SIZE, events.length).toLocaleString("en-US")} of ${events.length.toLocaleString("en-US")} events`);
      const body = {
        source: { surface: scanner.surface, kind: "local_logs" },
        events: batch.map((e) => toWireEvent(e, caps, config, installId, scanner.surface))
      };
      await writeLastSync(body);
      const res = await fetch(`${auth.baseUrl}/api/cli/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${auth.token}`,
          ...versionHeaders()
        },
        body: JSON.stringify(body)
      });
      if (res.status === 401) await disconnect(await refusalReason(res));
      if (res.status === 426) throw new CliOutdatedError(await parkOutdated(await minimumFrom(res) ?? served.cli?.minimum));
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        throw new Error(
          `Sync failed for ${scanner.surface} (${res.status})${b?.error ? `: ${b.error}` : ""}`
        );
      }
      const result = await res.json();
      if (state.outdated && sameInstall(state.outdated, at)) delete state.outdated;
      grandInserted += result.inserted;
      grandSkipped += result.skipped;
      grandInbox += result.inboxCount;
      const held = typeof result.heldElsewhere === "number" && result.heldElsewhere > 0 ? Math.min(result.heldElsewhere, result.skipped) : 0;
      grandHeldElsewhere += held;
      surfaceInserted += result.inserted;
      surfaceSkipped += result.skipped - held;
      surfaceHeld += held;
    }
    took.sending += since0() - t0;
    surfaces.push({ surface: scanner.surface, inserted: surfaceInserted, skipped: surfaceSkipped });
    if (surfaceHeld > 0) progress(`${scanner.surface}: ${surfaceHeld.toLocaleString("en-US")} with another account`);
    if (!since) heldOnFullRead += surfaceHeld;
    await stampSurface(state, scanner.surface, scanner.revision, scanStartedAt);
  }
  if (config.pendingBackfill) {
    config.pendingBackfill = false;
    await writeConfig(config);
  }
  if (!anyEvents) {
    progressDone();
    if (heldByScope > 0) {
      console.log(`Nothing in scope to sync \u2014 ${heldByScope} event(s) held back by your scope (see \`centrail repos\`).`);
    } else {
      console.log(
        anyWatermark ? "No new events since the last sync." : "No agent usage found (Claude Code, Copilot CLI, Codex)."
      );
    }
    if (notice) progress(updateNoticeLine(notice));
    return;
  }
  if (attributionEvents.length > 0) {
    progressStatus("Matching events to commits\u2026");
    const t0 = since0();
    await pushAttributions(auth, attributionEvents, resolver, config, caps, installId);
    took.commits += since0() - t0;
  }
  const secs = (ms) => `${(ms / 1e3).toFixed(1)} s`;
  progressDetail(`took: reading logs ${secs(took.reading)} \xB7 placing ${secs(took.placing)} \xB7 sending ${secs(took.sending)} \xB7 commits and ship status ${secs(took.commits)}`);
  progressDone();
  for (const line of summaryLines({ inserted: grandInserted, skipped: grandSkipped - grandHeldElsewhere, inbox: grandInbox, heldByScope, surfaces })) {
    console.log(line);
  }
  if (heldOnFullRead > 0) console.log(heldElsewhereLine(heldOnFullRead));
  if (notice) progress(updateNoticeLine(notice));
}
function heldElsewhereLine(n) {
  return n === 1 ? "1 event was already synced from this machine to another account; it stays there." : `${n.toLocaleString("en-US")} events were already synced from this machine to another account; they stay there.`;
}
async function disconnect(reason) {
  progressDone();
  await parkAuth(reason);
  throw new Error(disconnectedMessage({ at: (/* @__PURE__ */ new Date()).toISOString(), reason }));
}
function accountLabel(auth, fresh) {
  const email = fresh?.email ?? auth.account?.email;
  return email ? ` as ${email}` : "";
}
async function learnConfigDirs() {
  const known = claudeConfigDirs();
  const learned = [];
  for (const line of (await readSidecar()).values()) {
    if (line.surface !== "claude-code" || !line.transcript) continue;
    const i = line.transcript.replace(/\\/g, "/").lastIndexOf("/projects/");
    if (i <= 0) continue;
    const dir = line.transcript.slice(0, i);
    if (!known.includes(dir) && !learned.includes(dir)) learned.push(dir);
  }
  if (learned.length > 0) process.env.CLAUDE_CONFIG_DIR = [...known, ...learned].join(",");
}
async function stampSurface(state, surface, revision, scanStartedAt) {
  stampWatermark(state, surface, revision, scanStartedAt);
  await writeState(state);
}
async function pushAttributions(auth, events, resolver, config, caps, installId) {
  const identityAware = caps.fields.has("repo");
  const serverMatches = identityAware && caps.fields.has("match");
  const buckets = /* @__PURE__ */ new Map();
  const bucket = (root, ref, name, key) => {
    const id = `${root}\0${ref}`;
    let b = buckets.get(id);
    if (!b) buckets.set(id, b = { root, ref, name, key, events: [] });
    return b;
  };
  const orphans = [];
  for (const e of events) {
    const repo = e.metadata.repo;
    if (!repo || repo.source === "folder") continue;
    const root = await resolver.liveRootFor(e);
    if (!root) {
      orphans.push(e);
      continue;
    }
    const shown = wireRepoRef(repo, config, installId);
    bucket(root, "HEAD", shown.name, shown.key).events.push(e);
  }
  const rootByKey = /* @__PURE__ */ new Map();
  for (const b of buckets.values()) if (!rootByKey.has(b.key)) rootByKey.set(b.key, b.root);
  for (const e of orphans) {
    const repo = e.metadata.repo;
    const shown = wireRepoRef(repo, config, installId);
    let root = rootByKey.get(shown.key);
    if (!root) {
      const found = await resolver.liveRootForKey(repo.key);
      if (!found) continue;
      rootByKey.set(shown.key, root = found);
    }
    const branch = resolver.sidecarBranchFor(e);
    bucket(root, branch ? `refs/heads/${branch}` : "--all", shown.name, shown.key).events.push(e);
  }
  if (buckets.size === 0) return;
  const repos = [];
  const attributions = [];
  const sizedRoots = /* @__PURE__ */ new Set();
  for (const { root, ref, name, key, events: repoEvents } of buckets.values()) {
    const commits = serverMatches ? [] : await readRepoCommits(root, ref);
    if (!sizedRoots.has(root)) {
      sizedRoots.add(root);
      const size = await readRepoSize(root);
      repos.push({
        name,
        ...identityAware ? { key } : {},
        totalLoc: size.totalLoc,
        fileCount: size.fileCount
      });
    }
    if (serverMatches) continue;
    const input = repoEvents.map((e) => ({
      externalId: e.externalId,
      occurredAt: e.occurredAt
    }));
    const matched = matchEventsToCommits(input, commits);
    const branchByExternalId = new Map(
      repoEvents.map((e) => [e.externalId, e.metadata.gitBranch || null])
    );
    for (const m of matched) {
      attributions.push({
        externalId: m.externalId,
        repoName: name,
        ...identityAware ? { repoKey: key } : {},
        commitSha: m.sha,
        committedAt: m.committedAt.toISOString(),
        branch: wireBranch(branchByExternalId.get(m.externalId), config),
        linesAdded: m.linesAdded,
        linesDeleted: m.linesDeleted,
        filesChanged: m.filesChanged
      });
    }
  }
  if (attributions.length > 0) {
    const ATTR_CHUNK = 1e3;
    let totalLinked = 0;
    try {
      for (let i = 0; i < attributions.length; i += ATTR_CHUNK) {
        const chunk = attributions.slice(i, i + ATTR_CHUNK);
        const res = await fetch(`${auth.baseUrl}/api/cli/attribute`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${auth.token}`,
            ...versionHeaders()
          },
          body: JSON.stringify({ repos, attributions: chunk })
        });
        if (res.status === 426) throw new CliOutdatedError(await parkOutdated(await minimumFrom(res)));
        if (res.ok) {
          const r = await res.json();
          totalLinked += r.linked;
        } else {
          const body = await res.json().catch(() => null);
          console.warn(`  \u26A0 Attribution chunk skipped (${res.status})${body?.error ? `: ${body.error}` : ""}.`);
        }
      }
      if (totalLinked > 0) {
        console.log(`  \u21B3 Attributed ${totalLinked} event(s) to commits.`);
      }
    } catch (err) {
      if (err instanceof CliOutdatedError) throw err;
      console.warn("  \u26A0 Attribution request failed:", err.message);
    }
  }
  const fateRepos = /* @__PURE__ */ new Map();
  for (const b of buckets.values()) {
    const id = identityAware ? b.key : b.root;
    const entry = fateRepos.get(id);
    if (!entry) fateRepos.set(id, { roots: [b.root], name: b.name, key: identityAware ? b.key : void 0 });
    else if (!entry.roots.includes(b.root)) entry.roots.push(b.root);
  }
  const memo = await loadFactsMemo();
  const tally = await runFatePass(auth, [...fateRepos.values()], serverMatches ? repos : [], identityAware ? installId : void 0, caps, config, memo).finally(() => memo.save());
  if (tally) {
    console.log(`  \u21B3 ${formatShipStatusLine(tally)}`);
  }
}

// src/index.ts
var [, , command, ...rest] = process.argv;
var flags = {
  url: void 0,
  full: false,
  last: false,
  noBrowser: false,
  json: false,
  yes: false,
  dryRun: false,
  fix: false,
  agents: []
};
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--url") flags.url = rest[++i];
  else if (rest[i] === "--full") flags.full = true;
  else if (rest[i] === "--last") flags.last = true;
  else if (rest[i] === "--no-browser") flags.noBrowser = true;
  else if (rest[i] === "--json") flags.json = true;
  else if (rest[i] === "-y" || rest[i] === "--yes") flags.yes = true;
  else if (rest[i] === "--dry-run") flags.dryRun = true;
  else if (rest[i] === "--fix") flags.fix = true;
  else if (rest[i] === "--agent") flags.agents.push(rest[++i] ?? "");
  else if (rest[i] === "--quiet") setProgressMode("quiet");
  else if (rest[i] === "--verbose") setProgressMode("verbose");
}
var USAGE = `centrail \u2014 sync local AI agent usage to centrail.org

Usage:
  centrail connect [--url <base>]   Pair this machine with your account (opens your browser; --no-browser),
                                    then set up your agents
  centrail setup [--agent <name>] [-y] [--dry-run]
                                    Sync after every agent turn: Claude Code's plugin; a hook in Codex,
                                    Gemini CLI and Copilot CLI; an extension in Pi. Cursor and OpenCode
                                    (repo identity only, no usage yet) only when named
                                    (--agent claude-code|codex|gemini-cli|copilot-cli|pi|cursor|opencode;
                                    asks once unless -y)
  centrail doctor [--json] [--fix]  Check each agent's integration and centrail's version (read-only; --fix repairs)
  centrail uninstall [--agent <name>] [-y]
                                    Remove centrail's plugin, hooks and launcher
  centrail upgrade [-y]             Update this copy of centrail the way it was installed
  centrail status                   Which account this machine syncs to, and whether its pairing still works
  centrail --version                Print this copy's version
  centrail sync [--full]            Push new usage events (--full rescans everything)
                                    Progress shows in a terminal; --quiet hides it, --verbose forces it
  centrail inspect --last           Print the last payload exactly as it left this machine
  centrail scope                    Review which repos and folders sync (asked once at connect)
  centrail repos                    List them with status
  centrail exclude <repo>           Nothing about this repo leaves (host/owner/repo or folder name)
  centrail include <repo>           Undo an exclude; in allow mode, add it
  centrail surfaces [<name> on|off] Enable or disable a source (claude-code, codex, copilot-cli,
                                    gemini-cli, pi)
  centrail import <ccusage.json>    Import a ccusage "claude daily/session --json" file as Measured history
`;
var DEPRECATED = {
  "setup-plugin": "centrail setup --agent claude-code",
  "install-hooks": "centrail setup",
  "uninstall-hooks": "centrail uninstall",
  "doctor-hooks": "centrail doctor"
};
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}
try {
  if (command && DEPRECATED[command]) {
    console.error(`centrail ${command} is deprecated and will be removed in the next release: use \`${DEPRECATED[command]}\`.`);
  }
  const interactive = isInteractiveTerminal();
  const agents = parseAgents(flags.agents.filter(Boolean));
  if (command !== "hook" && command !== "doctor" && command !== "doctor-hooks" && interactive) await recordNode();
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(`centrail ${CLI_VERSION}`);
  } else if (command === "connect") {
    await runConnect({ baseUrl: flags.url, noBrowser: flags.noBrowser });
  } else if (command === "status") {
    await runStatus();
  } else if (command === "sync") {
    await runSync({ full: flags.full });
  } else if (command === "setup") {
    await runIntegrationSetup({ agents, yes: flags.yes, dryRun: flags.dryRun, interactive });
  } else if (command === "setup-plugin") {
    await runIntegrationSetup({ agents: ["claude-code"], yes: flags.yes, dryRun: flags.dryRun, interactive });
  } else if (command === "install-hooks") {
    await runIntegrationSetup({ agents, yes: true, dryRun: flags.dryRun, interactive });
  } else if (command === "uninstall") {
    await runUninstall({ agents, yes: flags.yes, interactive });
  } else if (command === "uninstall-hooks") {
    await runUninstall({ agents, yes: true, interactive, keepPlugin: true });
  } else if (command === "doctor") {
    await runDoctor({ json: flags.json, fix: flags.fix, interactive });
  } else if (command === "doctor-hooks") {
    if (flags.json) await runHooksDoctor(void 0, void 0, { json: true });
    else await runDoctor({ fix: flags.fix, interactive });
  } else if (command === "upgrade") {
    await runUpgrade({ yes: flags.yes, interactive });
  } else if (command === "inspect") {
    await runInspect();
  } else if (command === "hook") {
    const named = rest.includes("--surface") ? rest[rest.indexOf("--surface") + 1] : void 0;
    const surface = named && HOOK_SURFACES.includes(named) ? named : "claude-code";
    try {
      await runStopHook(await readStdin(), surface);
    } catch {
    }
    process.stdout.write(hookReply(surface));
  } else if (command === "scope") {
    await runSetup({ interactive: true });
  } else if (command === "repos") {
    await runRepos();
  } else if (command === "exclude" || command === "include") {
    const name = rest[0];
    if (!name) {
      console.error(`Usage: centrail ${command} <repo>`);
      process.exit(1);
    }
    if (command === "exclude") await runExclude(name);
    else await runInclude(name);
  } else if (command === "import") {
    if (!rest[0]) {
      console.error("Usage: centrail import <ccusage.json>");
      process.exit(1);
    }
    await runImport(rest[0]);
  } else if (command === "surfaces") {
    await runSurfaces(rest);
  } else {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }
} catch (err) {
  progressDone();
  console.error(`\u2717 ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
