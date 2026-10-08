#!/usr/bin/env node

// src/commands/connect.ts
import { readdir as readdir4 } from "node:fs/promises";

// ../parsers/src/providers/claude-code.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join as join2 } from "node:path";

// ../parsers/src/providers/evidence.ts
import { isAbsolute, join } from "node:path";
var NO_EVIDENCE = Object.freeze({ writes: [], reads: [] });
function mergeEvidence(a, b) {
  if (!a)
    return b ?? { writes: [], reads: [] };
  if (!b)
    return a;
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
  if (writeField)
    return { writes: absolute(input[writeField]), reads: [] };
  const readField = CLAUDE_READ_TOOLS[name];
  if (readField)
    return { writes: [], reads: absolute(input[readField]) };
  if (name === "Bash")
    return { writes: [], reads: bashPaths(typeof input.command === "string" ? input.command : "") };
  return { writes: [], reads: [] };
}
var SYSTEM_PREFIXES = ["/dev", "/proc", "/sys", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];
var BASH_PATH = /(?:^|[\s=:;|&(<>'"`])(?:'((?:[A-Za-z]:[\\/]|\/)[^']+)'|"((?:[A-Za-z]:[\\/]|\/)[^"]+)"|((?:[A-Za-z]:[\\/]|\/)[^\s'"`;|&<>()]+))/g;
function bashPaths(command2) {
  const out = [];
  for (const m of command2.matchAll(BASH_PATH)) {
    const path = m[1] ?? m[2] ?? m[3];
    if (!path)
      continue;
    if (path.startsWith("//"))
      continue;
    if (SYSTEM_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)))
      continue;
    if (!out.includes(path))
      out.push(path);
  }
  return out;
}
function codexCallEvidence(name, argumentsJson, cwd) {
  if (typeof name !== "string" || typeof argumentsJson !== "string")
    return { writes: [], reads: [] };
  let args;
  try {
    args = JSON.parse(argumentsJson);
  } catch {
    return { writes: [], reads: [] };
  }
  if (!isObject(args))
    return { writes: [], reads: [] };
  if (name === "shell" || name === "shell_command" || name === "exec_command" || name === "local_shell") {
    const reads = [];
    const workdir = args.workdir;
    if (typeof workdir === "string" && isAbsolute(workdir))
      reads.push(workdir);
    const command2 = Array.isArray(args.command) ? args.command.filter((c) => typeof c === "string").join(" ") : typeof args.command === "string" ? args.command : "";
    for (const p of bashPaths(command2))
      if (!reads.includes(p))
        reads.push(p);
    return { writes: [], reads };
  }
  if (name === "apply_patch") {
    const patch = typeof args.input === "string" ? args.input : typeof args.patch === "string" ? args.patch : "";
    const writes = [];
    for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
      const rel = m[1].trim();
      const abs = isAbsolute(rel) ? rel : join(cwd, rel);
      if (!writes.includes(abs))
        writes.push(abs);
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
  for (const base of bases)
    for (const path of await listTranscripts(base, since))
      files.push(path);
  const events = [];
  for (let i = 0; i < files.length; i++) {
    await readTranscript(files[i], events);
    opts.onFile?.(i + 1, files.length);
  }
  const folded = foldSidechainReplays(events);
  if (!since)
    return collapseUsageEvents(folded);
  const inWindow = new Set(folded.filter((e) => e.occurredAt > since).map((e) => e.externalId));
  const collapsed = collapseUsageEvents(folded);
  if (!opts.wholeFiles)
    return collapsed.filter((e) => inWindow.has(e.externalId));
  for (const e of collapsed)
    if (!inWindow.has(e.externalId))
      e.metadata.context = true;
  return collapsed;
}
function foldSidechainReplays(events) {
  const parentId = /* @__PURE__ */ new Map();
  for (const e of events) {
    const m = e.metadata;
    if (m.isSidechain === true || !m.messageId)
      continue;
    const k = `${m.sessionId ?? ""}\0${m.messageId}`;
    if (!parentId.has(k))
      parentId.set(k, e.externalId);
  }
  for (const e of events) {
    const m = e.metadata;
    if (m.isSidechain !== true || !m.messageId)
      continue;
    const id = parentId.get(`${m.sessionId ?? ""}\0${m.messageId}`);
    if (id && !/:(iter|advisor):\d+$/.test(e.externalId))
      e.externalId = id;
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
      if (prevSide)
        byId.set(e.externalId, e);
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
      if (e.occurredAt < prev.occurredAt)
        prev.occurredAt = e.occurredAt;
      continue;
    }
    prev.inputTokens = Math.max(prev.inputTokens, e.inputTokens);
    prev.outputTokens = Math.max(prev.outputTokens, e.outputTokens);
    prev.cacheReadTokens = Math.max(prev.cacheReadTokens, e.cacheReadTokens);
    prev.cacheCreationTokens = Math.max(prev.cacheCreationTokens, e.cacheCreationTokens);
    prev.cacheCreation5mTokens = Math.max(prev.cacheCreation5mTokens, e.cacheCreation5mTokens);
    prev.cacheCreation1hTokens = Math.max(prev.cacheCreation1hTokens, e.cacheCreation1hTokens);
    if (e.speed && (!prev.speed || prev.speed === "standard"))
      prev.speed = e.speed;
    if (e.webSearchRequests)
      prev.webSearchRequests = Math.max(prev.webSearchRequests ?? 0, e.webSearchRequests);
    if (e.cacheWriteTokens !== void 0) {
      prev.cacheWriteTokens = Math.max(prev.cacheWriteTokens ?? 0, e.cacheWriteTokens);
    }
    if (e.metadata.touched)
      prev.metadata.touched = mergeEvidence(prev.metadata.touched, e.metadata.touched);
    if (!prev.metadata.turn)
      prev.metadata.turn = e.metadata.turn;
    if (e.occurredAt < prev.occurredAt)
      prev.occurredAt = e.occurredAt;
  }
  return [...byId.values()];
}
function usageExternalId(raw, message) {
  if (typeof raw.requestId === "string" && raw.requestId.length > 0)
    return raw.requestId;
  const messageId = message.id;
  if (typeof messageId !== "string" || messageId.length === 0)
    return null;
  return `msg:${messageId}`;
}
async function listTranscripts(basePath, since) {
  let entries;
  try {
    entries = await readdir(basePath);
  } catch (err) {
    if (err.code === "ENOENT")
      return [];
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
    if (!dirStat.isDirectory())
      continue;
    for (const path of await listSessionFiles(dir)) {
      let fileStat;
      try {
        fileStat = await stat(path);
      } catch {
        continue;
      }
      if (since && fileStat.mtime < since)
        continue;
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
    if (!line.trim())
      continue;
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
      for (const extra of extraIterations(raw, parsed))
        events.push(extra);
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
      if (entry.name.endsWith(".jsonl"))
        files.push(join2(dir, entry.name));
      continue;
    }
    if (!entry.isDirectory())
      continue;
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
    if (!isObject2(raw) || raw.type !== "user" || raw.isMeta === true)
      return;
    const message = raw.message;
    if (!isObject2(message))
      return;
    const content = message.content;
    if (typeof content === "string")
      this.n++;
    else if (Array.isArray(content) && !content.some((b) => isObject2(b) && b.type === "tool_result"))
      this.n++;
  }
};
function lineEvidence(message) {
  let out = { writes: [], reads: [] };
  if (!Array.isArray(message.content))
    return out;
  for (const block of message.content) {
    if (isObject2(block) && block.type === "tool_use")
      out = mergeEvidence(out, claudeToolEvidence({ name: block.name, input: block.input }));
  }
  return out;
}
function extraIterations(raw, top) {
  const iterations = iterationsOf(raw);
  if (iterations.length < 2)
    return [];
  const firstFallback = iterations.findIndex((it) => it.type === "fallback_message");
  const out = [];
  iterations.forEach((it, i) => {
    const firstAttempt = firstFallback > 0 && i < firstFallback && it.type === "message";
    const advisor = it.type === "advisor_message";
    if (!firstAttempt && !advisor)
      return;
    if (typeof it.model !== "string" || !it.model || it.model === "<synthetic>")
      return;
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
  if (!isObject2(raw) || !isObject2(raw.message) || !isObject2(raw.message.usage))
    return [];
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
  if (!fb)
    return;
  Object.assign(e, usageFields(fb));
  if (typeof fb.model === "string" && fb.model)
    e.model = fb.model;
  e.metadata.fallback = true;
}
function parseAssistantEvent(raw, turn) {
  if (!isObject2(raw))
    return null;
  if (raw.type !== "assistant")
    return null;
  const message = raw.message;
  if (!isObject2(message))
    return null;
  const usage = message.usage;
  if (!isObject2(usage))
    return null;
  const model = message.model;
  const timestamp = raw.timestamp;
  if (typeof model !== "string")
    return null;
  if (typeof timestamp !== "string")
    return null;
  const externalId = usageExternalId(raw, message);
  if (!externalId)
    return null;
  if (model === "<synthetic>")
    return null;
  const occurredAt = new Date(timestamp);
  if (Number.isNaN(occurredAt.getTime()))
    return null;
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
  if (typeof usage.speed === "string" && /^[a-z_-]{1,32}$/.test(usage.speed))
    out.speed = usage.speed;
  const web = isObject2(usage.server_tool_use) ? usage.server_tool_use.web_search_requests : void 0;
  if (typeof web === "number" && Number.isInteger(web) && web > 0 && web <= 1e4)
    out.webSearchRequests = web;
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
    if (n > 1)
      event.externalId = `${event.externalId}:${n}`;
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
    if (err.code === "ENOENT")
      return [];
    throw err;
  }
  const events = [];
  for (let i = 0; i < entries.length; i++) {
    await readSession(basePath, entries[i], opts.since, events);
    opts.onFile?.(i + 1, entries.length);
  }
  return suffixDuplicateExternalIds(events);
}
async function readSession(basePath, entry, since, events) {
  const dir = join3(basePath, entry);
  let dirStat;
  try {
    dirStat = await stat2(dir);
  } catch {
    return;
  }
  if (!dirStat.isDirectory())
    return;
  const ws = await readWorkspace(join3(dir, "workspace.yaml"));
  if (!ws)
    return;
  const sessionStart = new Date(ws.created_at ?? "");
  const segments = await readShutdownSegments(join3(dir, "events.jsonl"));
  const sessionId = ws.id ?? entry;
  for (const segment of segments) {
    const segDate = new Date(segment.timestamp ?? "");
    const occurredAt = Number.isNaN(segDate.getTime()) ? sessionStart : segDate;
    if (Number.isNaN(occurredAt.getTime()))
      continue;
    if (since && occurredAt <= since)
      continue;
    for (const [model, m] of Object.entries(segment.modelMetrics)) {
      const usage = isObject3(m) && isObject3(m.usage) ? m.usage : null;
      if (!usage)
        continue;
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
    if (idx === -1)
      continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    if (key)
      out[key] = value;
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
    if (!line.trim())
      continue;
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
import { join as join4, relative } from "node:path";
function codexHomeDir() {
  return codexHomeDirs()[0];
}
function codexHomeDirs() {
  const configured = process.env.CODEX_HOME;
  if (!configured)
    return [join4(homedir3(), ".codex")];
  const dirs = configured.split(",").map((dir) => dir.trim()).filter(Boolean);
  return dirs.length > 0 ? dirs : [join4(homedir3(), ".codex")];
}
async function scanCodexLogs(opts) {
  const files = opts.basePath ? await findJsonlFiles(opts.basePath) : await findCodexUsageFiles();
  const events = [];
  const metaByPath = /* @__PURE__ */ new Map();
  for (const path of files)
    metaByPath.set(path, await readForkMeta(path));
  const pathBySession = /* @__PURE__ */ new Map();
  for (const [path, m] of metaByPath)
    if (m.sessionId && !pathBySession.has(m.sessionId))
      pathBySession.set(m.sessionId, path);
  const parents = /* @__PURE__ */ new Map();
  const toRead = [];
  for (const path of files) {
    if (opts.since) {
      try {
        if ((await stat3(path)).mtime < opts.since)
          continue;
      } catch {
        continue;
      }
    }
    toRead.push(path);
  }
  for (let i = 0; i < toRead.length; i++) {
    const path = toRead[i];
    let parsed = await parseSession(path, void 0);
    const fork = metaByPath.get(path);
    if (fork?.forkedFrom)
      parsed = await dropForkReplay(parsed, fork, pathBySession.get(fork.forkedFrom), parents);
    for (const e of parsed) {
      if (opts.since && e.occurredAt <= opts.since) {
        if (!opts.wholeFiles)
          continue;
        e.metadata.context = true;
      }
      events.push(e);
    }
    opts.onFile?.(i + 1, toRead.length);
  }
  return suffixDuplicateExternalIds(events);
}
var REPLAY_BURST_MS = 1e3;
async function readForkMeta(path) {
  let content;
  try {
    content = await readFile3(path, "utf-8");
  } catch {
    return {};
  }
  for (const line of content.split("\n", 50)) {
    if (!line.includes('"session_meta"'))
      continue;
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
  if (parentPath) {
    let parent = parents.get(parentPath);
    if (!parent) {
      parent = await parseSession(parentPath, void 0);
      parents.set(parentPath, parent);
    }
    const at = fork.forkedAt?.getTime();
    const replayed = at === void 0 || Number.isNaN(at) ? parent.length : parent.filter((e) => e.occurredAt.getTime() <= at).length;
    return child.slice(replayed);
  }
  let burst = 0;
  while (burst + 1 < child.length && child[burst + 1].occurredAt.getTime() - child[burst].occurredAt.getTime() < REPLAY_BURST_MS)
    burst++;
  return burst > 0 ? child.slice(burst + 1) : child;
}
async function findCodexUsageFiles() {
  const files = [];
  for (const home of codexHomeDirs()) {
    const roots = [join4(home, "sessions"), join4(home, "archived_sessions")];
    const seenRelativePaths = /* @__PURE__ */ new Set();
    let foundStandardRoot = false;
    for (const root of roots) {
      if (!await isDirectory(root))
        continue;
      foundStandardRoot = true;
      for (const path of await findJsonlFiles(root)) {
        const key = relative(root, path);
        if (seenRelativePaths.has(key))
          continue;
        seenRelativePaths.add(key);
        files.push(path);
      }
    }
    if (!foundStandardRoot)
      for (const f of await findJsonlFiles(home))
        files.push(f);
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
    if (err.code === "ENOENT")
      return [];
    throw err;
  }
  const files = [];
  for (const entry of entries) {
    const path = join4(basePath, entry.name);
    if (entry.isDirectory())
      for (const f of await findJsonlFiles(path))
        files.push(f);
    else if (entry.isFile() && entry.name.endsWith(".jsonl"))
      files.push(path);
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
  const context = {};
  const events = [];
  let previousTotals = null;
  let baselineValid = true;
  for (const line of content.split("\n")) {
    if (!line.trim())
      continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject4(raw) || !isObject4(raw.payload))
      continue;
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
    if (raw.type !== "event_msg" || raw.payload.type !== "token_count")
      continue;
    const parsed = parseTokenCount(raw, context, previousTotals, baselineValid);
    if (parsed.total) {
      previousTotals = parsed.total;
      baselineValid = true;
    } else if (parsed.bareLast) {
      baselineValid = false;
    }
    const event = parsed.event;
    if (event && (!since || event.occurredAt > since))
      events.push(event);
  }
  return events;
}
function readSessionMeta(payload, context) {
  context.sessionId = stringOr2(payload.session_id) ?? stringOr2(payload.id);
  context.cwd = stringOr2(payload.cwd);
  context.client = stringOr2(payload.originator) ?? stringOr2(payload.source);
  context.clientVersion = stringOr2(payload.cli_version);
  if (isObject4(payload.git))
    context.gitBranch = stringOr2(payload.git.branch);
}
function readTurnContext(payload, context) {
  const turnId = stringOr2(payload.turn_id);
  if (turnId !== context.turnId)
    context.touched = void 0;
  context.turnId = turnId;
  context.model = stringOr2(payload.model);
  context.cwd = stringOr2(payload.cwd) ?? context.cwd;
}
function parseTokenCount(raw, context, previousTotals, baselineValid) {
  const timestamp = stringOr2(raw.timestamp);
  if (!timestamp || !context.sessionId)
    return { event: null, total: null, bareLast: false };
  const occurredAt = new Date(timestamp);
  if (Number.isNaN(occurredAt.getTime()))
    return { event: null, total: null, bareLast: false };
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
  const model = stringOr2(payload.model) ?? stringOr2(info.model) ?? context.model;
  if (!usage || !model)
    return { event: null, total, bareLast };
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
        turn: context.turnId ? `${context.sessionId}#${context.turnId}` : void 0,
        touched: context.touched ? { writes: [...context.touched.writes], reads: [...context.touched.reads] } : { writes: [], reads: [] }
      }
    },
    total,
    bareLast
  };
}
function readTokenUsage(raw) {
  if (!isObject4(raw))
    return null;
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
  if (cur >= prev || cur <= 0 || usageSum(last) <= 0)
    return false;
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

// ../parsers/src/providers/git-attribution.ts
var RECORD_SEP = "";
var UNIT_SEP = "";
function parseGitLogNumstat(text) {
  const commits = [];
  for (const record of text.split(RECORD_SEP)) {
    if (!record.trim())
      continue;
    const lines = record.split("\n");
    const [sha, iso, email] = lines[0].split(UNIT_SEP);
    if (!sha || !iso)
      continue;
    const authorEmail = email?.trim() ? email.trim().toLowerCase() : void 0;
    const committedAt = new Date(iso);
    if (Number.isNaN(committedAt.getTime()))
      continue;
    let linesAdded = 0;
    let linesDeleted = 0;
    let filesChanged = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim())
        continue;
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
  if (commits.length === 0)
    return [];
  const sorted = [...commits].sort(
    (a, b) => a.committedAt.getTime() - b.committedAt.getTime() || (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0)
  );
  const out = [];
  for (const ev of events) {
    const t = ev.occurredAt.getTime();
    const commit = sorted.find((c) => c.committedAt.getTime() >= t);
    if (!commit)
      continue;
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
        if (!tip)
          return false;
        const tipMs = Date.parse(tip);
        if (!Number.isFinite(tipMs))
          return false;
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
    revision: 3,
    scan: (opts) => scanClaudeCodeLogs(opts)
  },
  {
    surface: "copilot-cli",
    revision: 2,
    scan: (opts) => scanCopilotLogs(opts)
  },
  {
    surface: "codex",
    revision: 2,
    scan: (opts) => scanCodexLogs(opts)
  }
];

// src/config.ts
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile as readFile4, rename, rm, stat as stat4, writeFile } from "node:fs/promises";
import { homedir as homedir4 } from "node:os";
import { join as join5 } from "node:path";

// src/update.ts
import { realpathSync } from "node:fs";

// src/version.ts
var CLI_VERSION = "0.7.2";
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
  if (pluginRoot && p.startsWith(`${pluginRoot}/`) || p.endsWith("/scripts/centrail.mjs"))
    return "plugin";
  if (p.includes("/_npx/"))
    return "npx";
  if (p.includes("/installs/npm-centrail/"))
    return "mise";
  if (/\/(lib|npm)\/node_modules\/centrail\//.test(p) && !p.includes("/.volta/"))
    return "npm-global";
  return "unknown";
}
function howToUpdate(channel) {
  switch (channel) {
    case "plugin":
      return "it updates through Claude Code (/plugin)";
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
    if (isOlder(at.version, cli.latest))
      state.updateNotice = { ...at, latest: cli.latest };
    else if (state.updateNotice && sameInstall(state.updateNotice, at))
      delete state.updateNotice;
  }
  if (cli?.minimum) {
    if (isOlder(at.version, cli.minimum))
      state.outdated = { ...at, minimum: cli.minimum };
    else if (state.outdated && sameInstall(state.outdated, at))
      delete state.outdated;
  }
  return JSON.stringify([state.updateNotice, state.outdated]) !== before;
}
function hookParked(state, version = CLI_VERSION) {
  return state.outdated?.version === version;
}
function stillTrue(rec, at, floor) {
  if (!rec || !sameInstall(rec, at))
    return rec;
  return (floor ? isOlder(at.version, floor) : rec.version === at.version) ? rec : void 0;
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
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return void 0;
  const o = raw;
  const out = {};
  if (validVersion(o.latest))
    out.latest = o.latest;
  if (validVersion(o.minimum))
    out.minimum = o.minimum;
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
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return void 0;
  const o = raw;
  if (!validVersion(o.version))
    return void 0;
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
  if (!x || !y)
    return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0)
      return Math.sign(d);
  }
  if (!x[4] || !y[4])
    return x[4] ? -1 : y[4] ? 1 : 0;
  const p = x[4].split(".");
  const q = y[4].split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === void 0)
      return -1;
    if (q[i] === void 0)
      return 1;
    const m = /^\d+$/.test(p[i]);
    const n = /^\d+$/.test(q[i]);
    if (m && n) {
      const d = Number(p[i]) - Number(q[i]);
      if (d !== 0)
        return Math.sign(d);
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
  const obj = isObject5(raw) ? raw : {};
  const surfaces = {};
  if (isObject5(obj.surfaces)) {
    for (const [surface, value] of Object.entries(obj.surfaces)) {
      if (typeof value === "string")
        surfaces[surface] = value;
    }
  }
  const scannerRevisions = {};
  if (isObject5(obj.scannerRevisions)) {
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
    if (own)
      since = validDate(own);
    else if (state.lastSyncAt && SHARED_WATERMARK_SURFACES.has(surface))
      since = validDate(state.lastSyncAt);
  }
  for (const [key, iso] of Object.entries(state.surfaces)) {
    const revision = markRevision(key, surface);
    if (revision === void 0 || revision < scannerRevision)
      continue;
    const mark = validDate(iso);
    if (mark && (!since || mark > since))
      since = mark;
  }
  return since;
}
function stampWatermark(state, surface, revision, at) {
  state.surfaces[surface] = at.toISOString();
  state.scannerRevisions[surface] = revision;
  state.surfaces[`${surface}@${revision}`] = at.toISOString();
}
function markRevision(key, surface) {
  if (!key.startsWith(`${surface}@`))
    return void 0;
  const revision = Number(key.slice(surface.length + 1));
  return Number.isInteger(revision) && revision > 0 ? revision : void 0;
}
function validDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? void 0 : date;
}
function isObject5(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// src/config.ts
var CONFIG_DIR = process.env.CENTRAIL_CONFIG_DIR?.trim() || join5(homedir4(), ".config", "centrail");
var AUTH_PATH = join5(CONFIG_DIR, "auth.json");
var DISCONNECTED_PATH = join5(CONFIG_DIR, "auth.disconnected.json");
var STATE_PATH = join5(CONFIG_DIR, "state.json");
async function readAuth() {
  try {
    const raw = JSON.parse(await readFile4(AUTH_PATH, "utf-8"));
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
var NODE_PATH_FILE = join5(CONFIG_DIR, "node");
async function recordNode(execPath = process.execPath, file = NODE_PATH_FILE) {
  try {
    const now = await readFile4(file, "utf-8").catch(() => "");
    if (now.trim() === execPath)
      return;
    await mkdir(join5(file, ".."), { recursive: true });
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
  if (!auth)
    return;
  await writeJsonAtomic(DISCONNECTED_PATH, { ...auth, disconnectedAt: (/* @__PURE__ */ new Date()).toISOString(), reason }, 384);
  await rm(AUTH_PATH, { force: true });
}
async function readDisconnected() {
  try {
    const raw = JSON.parse(await readFile4(DISCONNECTED_PATH, "utf-8"));
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
    return parseSyncState(JSON.parse(await readFile4(STATE_PATH, "utf-8")));
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
var LOCK_PATH = join5(CONFIG_DIR, "sync.lock");
var LOCK_STALE_MS = 15 * 60 * 1e3;
var LOCK_OWNER_FILE = "owner.json";
async function acquireSyncLock(lockPath = LOCK_PATH) {
  await mkdir(join5(lockPath, ".."), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lockPath);
      const owner = { pid: process.pid, nonce: randomUUID() };
      try {
        await writeFile(join5(lockPath, LOCK_OWNER_FILE), JSON.stringify(owner), {
          mode: 384
        });
      } catch (err) {
        await rm(lockPath, { recursive: true, force: true });
        throw err;
      }
      return async () => {
        const current = await readLockOwner(lockPath);
        if (current?.nonce === owner.nonce) {
          await rm(lockPath, { recursive: true, force: true });
        }
      };
    } catch (err) {
      if (err.code !== "EEXIST")
        throw err;
      const owner = await readLockOwner(lockPath);
      if (owner && processIsAlive(owner.pid))
        return null;
      let ageMs;
      try {
        ageMs = Date.now() - (await stat4(lockPath)).mtimeMs;
      } catch {
        continue;
      }
      if (!owner && ageMs < LOCK_STALE_MS)
        return null;
      await rm(lockPath, { recursive: true, force: true });
    }
  }
  return null;
}
async function readLockOwner(lockPath) {
  try {
    const raw = JSON.parse(
      await readFile4(join5(lockPath, LOCK_OWNER_FILE), "utf-8")
    );
    if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0 || typeof raw.nonce !== "string" || raw.nonce.length === 0) {
      return null;
    }
    return { pid: raw.pid, nonce: raw.nonce };
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
var CONFIG_PATH = join5(CONFIG_DIR, "config.json");
var DEFAULT_CONFIG = {
  installId: null,
  mode: "all",
  allowRepos: [],
  denyRepos: [],
  surfaces: {},
  scopeDecidedAt: null,
  pendingBackfill: false,
  hideRepoNames: false,
  hideBranchNames: false,
  pluginAnswer: null
};
function parseConfig(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return { ...DEFAULT_CONFIG };
  const o = raw;
  const surfaces = {};
  if (o.surfaces && typeof o.surfaces === "object" && !Array.isArray(o.surfaces)) {
    for (const [k, v] of Object.entries(o.surfaces)) {
      if (typeof v === "boolean")
        surfaces[k] = v;
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
    hideBranchNames: o.hideBranchNames === true,
    pluginAnswer: o.pluginAnswer === "yes" || o.pluginAnswer === "no" ? o.pluginAnswer : null
  };
}
function stringList(v) {
  return Array.isArray(v) ? v.filter((r) => typeof r === "string") : [];
}
async function readConfig() {
  try {
    return parseConfig(JSON.parse(await readFile4(CONFIG_PATH, "utf-8")));
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
  if (cfg.installId)
    return cfg.installId;
  cfg.installId = randomUUID();
  await writeConfig(cfg);
  return cfg.installId;
}
var LAST_SYNC_PATH = join5(CONFIG_DIR, "last-sync.json");
async function writeLastSync(body) {
  await writeJsonAtomic(LAST_SYNC_PATH, body, 384);
}
async function readLastSync() {
  try {
    return await readFile4(LAST_SYNC_PATH, "utf-8");
  } catch {
    return null;
  }
}

// src/browser.ts
import { spawn } from "node:child_process";
function shouldOpenBrowser(env = process.env, isTTY = process.stdout.isTTY === true, platform = process.platform) {
  if (!isTTY || env.CI || env.SSH_CONNECTION || env.SSH_TTY)
    return false;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.WSL_DISTRO_NAME)
    return false;
  return true;
}
function browserCommand(url, env = process.env, platform = process.platform) {
  const chosen = env.BROWSER?.split(":")[0]?.trim();
  if (chosen)
    return [chosen, [url]];
  if (platform === "darwin")
    return ["open", [url]];
  if (platform === "win32")
    return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  if (env.WSL_DISTRO_NAME)
    return ["wslview", [url]];
  return ["xdg-open", [url]];
}
function openBrowser(url, baseUrl) {
  try {
    if (new URL(url).origin !== new URL(baseUrl).origin)
      return false;
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

// src/commands/plugin-setup.ts
import { execFile as execFile2 } from "node:child_process";
import { constants as constants2 } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join as join9 } from "node:path";
import { createInterface as createInterface2 } from "node:readline/promises";

// src/commands/hooks-install.ts
import { constants, realpathSync as realpathSync3 } from "node:fs";
import { copyFile, mkdir as mkdir3, readFile as readFile8, writeFile as writeFile3 } from "node:fs/promises";
import { dirname as dirname4, join as join8 } from "node:path";
import { stat as stat7 } from "node:fs/promises";

// src/commands/scope.ts
import { createInterface } from "node:readline/promises";

// src/resolver.ts
import { stat as stat6 } from "node:fs/promises";

// src/git.ts
import { execFile, spawn as spawn2 } from "node:child_process";
import { readFile as readFile5, stat as stat5 } from "node:fs/promises";
import { basename as basename2, dirname, join as join6, win32 } from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
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
  for (const key of GIT_REDIRECT_VARS)
    delete env[key];
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}
function exec(cmd, args, opts = {}) {
  return execFileAsync(cmd, args, { ...opts, env: gitEnv(), windowsHide: true });
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
  if (platform !== "win32")
    return p;
  const n = win32.normalize(p);
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
  return win32.normalize(p).toLowerCase();
}
async function nearestDirectory(path) {
  let dir = path;
  for (; ; ) {
    try {
      if ((await stat5(dir)).isDirectory())
        return dir;
    } catch {
    }
    const parent = dirname(dir);
    if (parent === dir)
      return null;
    dir = parent;
  }
}
function deepestRoot(roots, path) {
  let best = null;
  for (const r of roots)
    if (isWithin(path, r) && (!best || r.length > best.length))
      best = r;
  return best;
}
async function nestedCheckout(root, dir) {
  for (let d = dir; !samePath(d, root) && isWithin(d, root); d = dirname(d)) {
    try {
      await stat5(join6(d, ".git"));
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
    if (!common || basename2(common) !== ".git")
      return null;
    const main = dirname(common);
    return samePath(main, repoRoot) ? null : main;
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
    if (short)
      candidates.push(short.replace(/^origin\//, ""));
  } catch {
  }
  candidates.push("main", "master");
  try {
    const { stdout } = await exec("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
    const current = stdout.trim();
    if (current && current !== "HEAD")
      candidates.push(current);
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
    if (!base)
      return [];
    const { stdout } = await exec(
      "git",
      ["-C", repoRoot, "rev-list", "--reverse", `--max-count=${SQUASH_PREFIX_CAP}`, "--format=%H%x1f%cI%x1f%P", `${base}..${tipRef}`],
      { maxBuffer: FACT_BUFFER }
    );
    const range = stdout.split("\n").filter((l) => l.includes("")).map((l) => l.split("").map((x) => x.trim())).map(([sha, at, parents]) => ({ sha, at, merge: parents.split(" ").length > 1 }));
    if (!range.some((c) => c.merge))
      return range.map(({ sha, at }) => ({ sha, at, base }));
    const { stdout: pathOut } = await exec(
      "git",
      ["-C", repoRoot, "rev-list", "--ancestry-path", `${base}..${tipRef}`],
      { maxBuffer: FACT_BUFFER }
    );
    const onPath = new Set(pathOut.split("\n").map((l) => l.trim()).filter(Boolean));
    const out = [];
    for (const { sha, at } of range) {
      const own = onPath.has(sha) ? base : await mergeBase(sha);
      if (own)
        out.push({ sha, at, base: own });
    }
    return out;
  } catch {
    return [];
  }
}
function patchIds(repoRoot, commits) {
  if (commits.length === 0)
    return Promise.resolve({});
  return new Promise((resolve) => {
    const opts = { env: { ...gitEnv(), GIT_ATTR_NOSYSTEM: "1" }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true };
    const diff = spawn2(
      "git",
      ["-C", repoRoot, "-c", "core.quotePath=true", "-c", "core.attributesFile=/dev/null", "diff-tree", "--stdin", "-p", "--text", "--no-renames", "--diff-algorithm=myers", "--indent-heuristic", "--no-ext-diff", "--no-textconv"],
      opts
    );
    const ids = spawn2("git", ["-C", repoRoot, "patch-id", "--stable"], opts);
    let text = "";
    let ok = true;
    let open2 = 2;
    const done = (code) => {
      if (code !== 0)
        ok = false;
      if (--open2 > 0)
        return;
      const out = {};
      if (ok) {
        for (const line of text.split("\n")) {
          const [id, sha] = line.trim().split(/\s+/);
          if (id && sha)
            out[sha] = id;
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
    ids.stdout.on("data", (d) => text += d);
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
      if (!ref?.trim() || !name?.trim() || !sha?.trim())
        continue;
      if (symref?.trim())
        continue;
      if (name === "origin" || name === "origin/HEAD")
        continue;
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
  if (fileCount > LOC_FILE_CAP)
    return { totalLoc: null, fileCount };
  let totalLoc = 0;
  for (const rel of files) {
    try {
      const content = await readFile5(`${repoRoot}/${rel}`);
      if (content.byteLength > LOC_BYTES_CAP)
        continue;
      if (content.includes(0))
        continue;
      totalLoc += content.toString("utf-8").split("\n").length;
    } catch {
    }
  }
  return { totalLoc, fileCount };
}

// src/identity.ts
import { createHmac } from "node:crypto";
import { realpathSync as realpathSync2 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { readFile as readFile6 } from "node:fs/promises";
import { basename as basename3, dirname as dirname2, join as join7 } from "node:path";
function remoteKey(url) {
  const raw = url.trim();
  if (!raw)
    return null;
  let host;
  let path;
  let scp = false;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if (proto === "file")
      return null;
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
    if (!m)
      return null;
    host = m[1];
    path = m[2];
    scp = true;
  }
  host = host.toLowerCase();
  if (!isHostedName(host))
    return null;
  if (scp && path.startsWith("/") && !FORGES.has(host))
    return null;
  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!host || !path)
    return null;
  if (path.startsWith("~") || !FORGES.has(host) && HOME_ROOT.test(path))
    return null;
  if (host === "ssh.dev.azure.com") {
    const m = /^v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    if (!m)
      return null;
    host = "dev.azure.com";
    path = `${m[1]}/${m[2]}/_git/${m[3]}`;
  } else if (host === "vs-ssh.visualstudio.com") {
    const m = /^v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    if (!m)
      return null;
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
  if (/^[0-9.]+$/.test(host) || host.includes(":") || host.startsWith("["))
    return false;
  if (!host.includes("."))
    return false;
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
  const home = homedir5().replace(/[\/\\]+$/, "");
  if (samePath(p, home))
    return "~";
  try {
    if (samePath(realpathSync2.native(p), realpathSync2.native(home)))
      return "~";
  } catch {
  }
  return basename3(p);
}
async function repoIdentity(repoRoot) {
  const label = displayLabel(repoRoot);
  const remote = await readRemoteKey(repoRoot);
  const root = await readRootSha(repoRoot);
  if (remote)
    return { key: remote, label, source: "remote", ...root ? { root } : {} };
  if (root)
    return { key: `sha:${root}`, label, source: "root", root };
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
      const text = await readFile6(join7(d, ".git"), "utf-8");
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      const wt = m ? /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(m[1]) : null;
      return wt ? { folder: d, main: wt[1] } : null;
    } catch (err) {
      if (err.code === "EISDIR")
        return null;
    }
    const parent = dirname2(d);
    if (parent === d)
      return null;
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
import { basename as basename4 } from "node:path";

// src/sidecar.ts
import { appendFile, mkdir as mkdir2, readFile as readFile7, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname3 } from "node:path";
var SIDECAR_PATH = `${CONFIG_DIR}/sessions.jsonl`;
async function appendSidecar(line, path = SIDECAR_PATH) {
  await mkdir2(dirname3(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(line)}
`, { mode: 384 });
}
async function readSidecar(path = SIDECAR_PATH) {
  const out = /* @__PURE__ */ new Map();
  let text;
  try {
    text = await readFile7(path, "utf-8");
  } catch {
    return out;
  }
  for (const raw of text.split("\n")) {
    if (!raw.trim())
      continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isSidecarLine(line))
      continue;
    out.set(line.sessionId, line);
  }
  return out;
}
var SIDECAR_RETENTION_DAYS = 90;
async function compactSidecar(path = SIDECAR_PATH, now = Date.now()) {
  let text;
  try {
    text = await readFile7(path, "utf-8");
  } catch {
    return;
  }
  const keep = /* @__PURE__ */ new Map();
  const recent = [];
  const cutoff = now - 60 * 60 * 1e3;
  const lastSeen = /* @__PURE__ */ new Map();
  for (const raw of text.split("\n")) {
    if (!raw.trim())
      continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isSidecarLine(line))
      continue;
    const at = new Date(line.ts).getTime();
    lastSeen.set(line.sessionId, Math.max(lastSeen.get(line.sessionId) ?? -Infinity, at));
    if (at >= cutoff)
      recent.push(raw);
    else
      keep.set(line.sessionId, raw);
  }
  const expired = now - SIDECAR_RETENTION_DAYS * 24 * 60 * 60 * 1e3;
  for (const [sessionId, at] of lastSeen)
    if (at < expired)
      keep.delete(sessionId);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile2(tmp, [...keep.values(), ...recent].map((l) => `${l}
`).join(""), { mode: 384 });
  await replaceFile(tmp, path);
}
function isSidecarLine(v) {
  if (v === null || typeof v !== "object")
    return false;
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
    if (current && current !== "HEAD")
      return;
    const line = e.metadata.sessionId ? this.sidecar.get(e.metadata.sessionId) : void 0;
    if (line?.branch)
      e.metadata.gitBranch = line.branch;
  }
  async stamp(e) {
    this.fixBranch(e);
    if (e.metadata.repo)
      return;
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
    if (recorded && await this.answers(recorded, path))
      return roots[recorded];
    const live = deepestRoot(this.liveRoots, path);
    if (live && await this.answers(live, path))
      return this.identityForRoot(live);
    const dir = await this.dirFor(path);
    if (!dir)
      return null;
    const root = await this.rootFor(dir);
    return root ? this.identityForRoot(root) : null;
  }
  // Whether a known root holds `path` itself, rather than a checkout nested
  // inside it. A path whose folder is gone climbs above the root: it holds.
  async answers(root, path) {
    const dir = await this.dirFor(path);
    if (!dir)
      return true;
    const k = `${root}\0${dir}`;
    let nested = this.nestedByDir.get(k);
    if (nested === void 0)
      this.nestedByDir.set(k, nested = await nestedCheckout(root, dir));
    return !nested;
  }
  async dirFor(path) {
    let dir = this.dirByPath.get(path);
    if (dir === void 0)
      this.dirByPath.set(path, dir = await nearestDirectory(path));
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
    if (known !== void 0)
      return known;
    known = null;
    for (const line of this.sidecar.values()) {
      for (const [path, id] of Object.entries(line.roots ?? {})) {
        if (id.key !== key)
          continue;
        for (const candidate of [path, line.mains?.[path]]) {
          if (!candidate)
            continue;
          const root = await this.rootFor(candidate);
          if (root && (await this.identityForRoot(root))?.key === key) {
            known = root;
            break;
          }
        }
        if (known)
          break;
      }
      if (known)
        break;
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
        if (id)
          return id;
        return folderIdentity(cwd, this.installId);
      }
      if (fromSidecar?.repo)
        return fromSidecar.repo;
      if (await this.exists(cwd)) {
        const stale = await staleWorktree(cwd);
        const mainRoot = stale ? await this.rootFor(stale.main) : null;
        const id = mainRoot ? await this.identityForRoot(mainRoot) : null;
        if (id && stale)
          return { ...id, label: basename4(stale.folder) };
        return folderIdentity(cwd, this.installId);
      }
      if (fromSidecar)
        return folderIdentity(fromSidecar.cwd, this.installId);
      return null;
    }
    if (fromSidecar?.repo)
      return fromSidecar.repo;
    if (fromSidecar)
      return folderIdentity(fromSidecar.cwd, this.installId);
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
      if (root)
        this.liveRoots.add(root);
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
        known = (await stat6(cwd)).isDirectory();
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
  if (repo && listHas(cfg.denyRepos, repo))
    return "excluded";
  if (cfg.mode === "allow")
    return repo && listHas(cfg.allowRepos, repo) ? "synced" : "waiting";
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
    if (!repo)
      continue;
    let row = rows.get(repo.key);
    if (!row) {
      row = { key: repo.key, labels: [], source: repo.source, sessions: 0, events: 0, lastAt: e.occurredAt, sessionIds: /* @__PURE__ */ new Set() };
      rows.set(repo.key, row);
    }
    if (repo.label && !row.labels.includes(repo.label))
      row.labels.push(repo.label);
    if (e.metadata.sessionId)
      row.sessionIds.add(e.metadata.sessionId);
    row.events++;
    if (e.occurredAt > row.lastAt)
      row.lastAt = e.occurredAt;
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
function parseSelection(answer, count2) {
  const trimmed = answer.trim().toLowerCase();
  if (!trimmed)
    return null;
  const only = trimmed.startsWith("only");
  const nums = (only ? trimmed.slice(4) : trimmed).split(/[\s,]+/).map((t) => Number.parseInt(t, 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= count2);
  if (nums.length === 0)
    return null;
  return { mode: only ? "allow" : "all", picks: [...new Set(nums)].map((n) => n - 1) };
}

// src/commands/scope.ts
var SCOPE_UNANSWERED = "Scope not answered: repo names held back; run `centrail setup`.";
function isInteractiveTerminal() {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}
async function discoverRepos() {
  const installId = await ensureInstallId();
  const resolver = await IdentityResolver.create(installId);
  const events = [];
  for (const scanner of SCANNERS) {
    try {
      for (const e of await scanner.scan({}))
        events.push(e);
    } catch {
    }
  }
  for (const e of events)
    await resolver.stamp(e);
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
    console.log("  Change any time: `centrail setup`, `centrail exclude <repo>`, `centrail repos`.");
    return;
  }
  const rl = createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    process.stdout.write(prompt);
    const next = await lines.next();
    if (next.done)
      process.stdout.write("\n");
    return next.done ? "" : String(next.value);
  };
  try {
    const all = (await ask("  Sync all of these, and any new repo this machine touches? [Y/n] ")).trim().toLowerCase();
    if (all === "" || all.startsWith("y")) {
      if (cfg.mode === "allow")
        cfg.pendingBackfill = true;
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
          for (const k of keys)
            if (!cfg.denyRepos.includes(k))
              cfg.denyRepos.push(k);
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
  if (!cfg.scopeDecidedAt)
    cfg.pendingBackfill = true;
  cfg.scopeDecidedAt = (/* @__PURE__ */ new Date()).toISOString();
}
async function runRepos() {
  const cfg = await readConfig();
  printScope(await discoverRepos(), cfg);
  if (!cfg.scopeDecidedAt)
    console.log(`  ${SCOPE_UNANSWERED}`);
}
async function runInspect() {
  console.log(await readLastSync() ?? "No sync has run on this machine yet.");
  if (!(await readConfig()).scopeDecidedAt)
    console.error(SCOPE_UNANSWERED);
}
function printScope(rows, cfg) {
  const repos = rows.filter((r) => r.source !== "folder").length;
  const folders = rows.length - repos;
  console.log("");
  console.log(`  This machine's agents have touched ${repos} repo(s) and ${folders} folder(s):`);
  for (const line of renderRepoRows(rows, cfg))
    console.log(`  ${line}`);
  if (rows.length === 0)
    console.log("    (nothing yet)");
  const legend = cfg.mode === "allow" ? "\u2713 synced  \u2717 excluded  \u2026 waiting (allow mode: only listed repos sync)" : "\u2713 synced  \u2717 excluded";
  console.log(`  ${legend}`);
  const surfaces = SCANNERS.map((s) => `${s.surface} ${surfaceEnabled(cfg, s.surface) ? "on" : "off"}`).join("  ");
  console.log(`  Surfaces: ${surfaces}   (centrail surfaces <name> on|off)`);
}
async function runInclude(name) {
  const cfg = await updateConfig((c) => {
    c.denyRepos = c.denyRepos.filter((r) => r !== name);
    if (!c.allowRepos.includes(name))
      c.allowRepos.push(name);
    c.pendingBackfill = true;
  });
  console.log(
    cfg.mode === "allow" ? `Included "${name}" \u2014 it syncs from the next run.` : `Included "${name}" \u2014 it was ${cfg.denyRepos.includes(name) ? "excluded" : "already syncing"} (mode: all).`
  );
}
async function runExclude(name) {
  await updateConfig((c) => {
    c.allowRepos = c.allowRepos.filter((r) => r !== name);
    if (!c.denyRepos.includes(name))
      c.denyRepos.push(name);
  });
  console.log(`Excluded "${name}" \u2014 nothing about it leaves this machine from the next sync (events, commits, identity).`);
}
async function runSurfaces(args) {
  const [name, state] = args;
  const known = SCANNERS.map((s) => s.surface);
  if (!name) {
    const cfg = await readConfig();
    for (const s of known)
      console.log(`  ${s.padEnd(12)} ${surfaceEnabled(cfg, s) ? "on" : "off"}`);
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

// src/commands/hooks-install.ts
var HOOK_MARK = "hook stop";
function claudeSettingsPath() {
  return join8(claudeConfigDirs()[0], "settings.json");
}
function codexHooksPath() {
  return join8(codexHomeDir(), "hooks.json");
}
function hookCommand(node = process.execPath, script = process.argv[1]) {
  const abs = safeRealpath(script);
  return `${quote(node)} ${quote(abs)} hook stop`;
}
function installStopHook(settings, command2) {
  const hooks = isObject6(settings.hooks) ? { ...settings.hooks } : {};
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  const kept = stop.filter((g) => !isCentrailGroup(g));
  kept.push({ hooks: [{ type: "command", command: command2, timeout: 10 }] });
  return { ...settings, hooks: { ...hooks, Stop: kept } };
}
function uninstallStopHook(settings) {
  if (!isObject6(settings.hooks) || !Array.isArray(settings.hooks.Stop))
    return settings;
  const kept = settings.hooks.Stop.filter((g) => !isCentrailGroup(g));
  const hooks = { ...settings.hooks };
  if (kept.length > 0)
    hooks.Stop = kept;
  else
    delete hooks.Stop;
  const out = { ...settings, hooks };
  if (Object.keys(hooks).length === 0)
    delete out.hooks;
  return out;
}
async function runInstallHooks(opts, path = claudeSettingsPath(), codexPath = null) {
  if (!opts.remove && !(await readConfig()).scopeDecidedAt) {
    await runSetup({ interactive: process.stdin.isTTY === true });
  }
  const targets = [path];
  const codex = codexPath ?? (await isDir(codexHomeDir()) ? codexHooksPath() : null);
  if (codex)
    targets.push(codex);
  for (const target of targets) {
    const { settings, indent } = await readSettingsFile(target);
    if (!opts.remove && target === path && pluginEnabled(settings)) {
      console.log(`Claude Code runs centrail through its plugin (${PLUGIN_ID}); no hook added to ${target}.`);
      continue;
    }
    const next = opts.remove ? uninstallStopHook(settings) : installStopHook(settings, hookCommand());
    await writeSettingsFile(target, next, indent);
    console.log(opts.remove ? `Removed the centrail Stop hook from ${target}.` : `Installed the centrail Stop hook in ${target}.`);
  }
  if (opts.remove)
    return;
  console.log(
    `Every ${codex ? "Claude Code and Codex" : "Claude Code"} turn now records session id, folder, repo identity, branch, head and the
repos its files touched, locally, and starts a background \`centrail sync\` at most every 10 minutes.
Nothing leaves this machine except what \`centrail inspect --last\` shows.`
  );
}
async function isDir(p) {
  try {
    return (await stat7(p)).isDirectory();
  } catch {
    return false;
  }
}
function isCentrailGroup(g) {
  return isObject6(g) && Array.isArray(g.hooks) && g.hooks.some(
    (h) => isObject6(h) && typeof h.command === "string" && h.command.includes("centrail") && h.command.includes(HOOK_MARK)
  );
}
var PLUGIN_ID = "centrail@centrail";
function pluginEnabled(settings) {
  return isObject6(settings.enabledPlugins) && settings.enabledPlugins[PLUGIN_ID] === true;
}
async function readSettingsFile(path) {
  let raw;
  try {
    raw = await readFile8(path, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT")
      return { settings: {}, indent: "  " };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Cannot parse ${path}: ${err.message}`);
  }
  if (!isObject6(parsed))
    throw new Error(`Cannot parse ${path}: not a JSON object`);
  return { settings: parsed, indent: /^([ \t]+)"/m.exec(raw)?.[1] ?? "  " };
}
async function writeSettingsFile(path, settings, indent = "  ") {
  await mkdir3(dirname4(path), { recursive: true });
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
    if (code !== "EEXIST" && code !== "ENOENT")
      throw err;
  }
}
function safeRealpath(p) {
  try {
    return realpathSync3(p);
  } catch {
    return p;
  }
}
function quote(s) {
  return `"${s.replace(/"/g, '\\"')}"`;
}
function isObject6(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// src/commands/plugin-setup.ts
var MARKETPLACE = "centrail";
var MARKETPLACE_REPO = "braydenyancy/centrail-cli";
var RELEASE_REF = "release";
var PLUGIN_STEPS = `
  Claude Code can run centrail after every turn through its plugin, kept current by Claude Code:
    claude plugin marketplace add ${MARKETPLACE_REPO}#${RELEASE_REF}
    claude plugin install ${PLUGIN_ID}
  then turn on its updates: /plugin \u2192 Marketplaces \u2192 ${MARKETPLACE} \u2192 Enable auto-update.`;
async function offerPlugin(opts, deps = {}) {
  if ((await readConfig()).pluginAnswer && !opts.again)
    return;
  if (!opts.interactive) {
    console.log(PLUGIN_STEPS);
    return;
  }
  const claude = deps.claude === void 0 ? await findClaude() : deps.claude;
  if (!claude) {
    console.log(PLUGIN_STEPS);
    return;
  }
  console.log("");
  const reply = await (deps.ask ?? askLine)("  Keep centrail's Claude Code plugin installed and updated automatically? [Y/n] ");
  if (reply === null) {
    console.log(PLUGIN_STEPS);
    return;
  }
  const answer = reply.trim().toLowerCase();
  const yes = answer === "" || answer.startsWith("y");
  await updateConfig((c) => {
    c.pluginAnswer = yes ? "yes" : "no";
  });
  if (!yes) {
    console.log(PLUGIN_STEPS);
    return;
  }
  await setUpPlugin(claude, deps.settingsPath ?? claudeSettingsPath());
}
async function setUpPlugin(claude, path) {
  let file = await readOrSay(path);
  if (!file)
    return false;
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
      console.log("  Try again with `npx centrail setup-plugin`, or by hand:");
      console.log(PLUGIN_STEPS);
      return false;
    }
  }
  file = await readOrSay(path);
  if (!file)
    return false;
  const withUpdates = withMarketplace(file.settings, { ...marketplaceEntry(file.settings) ?? { source: RELEASE_SOURCE }, autoUpdate: true });
  const next = uninstallStopHook(withUpdates);
  const removedHook = JSON.stringify(next) !== JSON.stringify(withUpdates);
  await writeSettingsFile(path, next, file.indent);
  console.log("  \u2713 Claude Code plugin installed. Claude Code updates it after each release (from its next launch);");
  console.log(`    to stop that: /plugin \u2192 Marketplaces \u2192 ${MARKETPLACE} \u2192 Disable auto-update.`);
  if (removedHook)
    console.log("  \u2713 Removed the Stop hook `centrail install-hooks` wrote: the plugin's hook replaces it.");
  console.log("  Claude Code sessions already open: run /reload-plugins in each, or restart them, so their turns are recorded.");
  return true;
}
var RELEASE_SOURCE = { source: "github", repo: MARKETPLACE_REPO, ref: RELEASE_REF };
function marketplaceEntry(settings) {
  const all = settings.extraKnownMarketplaces;
  const entry = isObject7(all) ? all[MARKETPLACE] : void 0;
  return isObject7(entry) ? entry : void 0;
}
function withMarketplace(settings, entry) {
  const all = isObject7(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {};
  return { ...settings, extraKnownMarketplaces: { ...all, [MARKETPLACE]: entry } };
}
function isReleaseSource(source) {
  return isObject7(source) && source.source === "github" && source.repo === MARKETPLACE_REPO && source.ref === RELEASE_REF;
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
async function findClaude(env = process.env) {
  const win = process.platform === "win32";
  const exts = win ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir)
      continue;
    for (const ext of exts) {
      const bin = join9(dir, `claude${ext}`);
      try {
        await access(bin, constants2.X_OK);
      } catch {
        continue;
      }
      return (args) => new Promise((resolve) => {
        execFile2(win ? "claude" : bin, args, { shell: win, timeout: 18e4, windowsHide: true }, (err, stdout, stderr) => {
          const code = err ? typeof err.code === "number" ? err.code : 1 : 0;
          resolve({ code, output: `${stdout}${stderr}` });
        });
      });
    }
  }
  return null;
}
async function askLine(prompt) {
  process.stdout.write(prompt);
  if (process.stdin.readableEnded) {
    process.stdout.write("\n");
    return null;
  }
  const rl = createInterface2({ input: process.stdin });
  try {
    const next = await rl[Symbol.asyncIterator]().next();
    if (next.done)
      process.stdout.write("\n");
    return next.done ? null : String(next.value);
  } finally {
    rl.close();
  }
}
function isObject7(v) {
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
  if (url.protocol === "https:")
    return raw;
  if (url.protocol === "http:" && isLoopback)
    return raw;
  throw new Error(
    `Refusing to send your token over an insecure connection (${url.protocol}//${url.host}). Use https:// \u2014 http:// is allowed only for localhost.`
  );
}

// src/commands/connect.ts
var DEFAULT_BASE_URL = "https://centrail.org";
var PRIVATE_DEVICE_NAME = "Centrail CLI";
async function runConnect(opts, pluginDeps = {}) {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  assertSecureBaseUrl(baseUrl);
  const previous = await readAuth();
  if (previous) {
    console.log("");
    console.log(`  This machine is paired${previous.account ? ` with ${previous.account.email}` : ""}. Approving below re-pairs it;`);
    console.log("  approve as another account and it moves there: what it synced stays with the old account,");
    console.log("  and its usage from now on goes to the new one.");
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
    if (!poll.ok)
      continue;
    const body = await poll.json();
    if (body.status === "approved" && body.token) {
      const email = typeof body.account?.email === "string" && body.account.email ? body.account.email : void 0;
      await writeAuth({
        baseUrl,
        token: body.token,
        deviceName: PRIVATE_DEVICE_NAME,
        ...email ? { account: { email } } : {}
      });
      if (!email || previous?.account?.email !== email)
        await forgetWatermarks();
      console.log(email ? `  \u2713 Paired with ${email}` : `  \u2713 Paired (${PRIVATE_DEVICE_NAME})`);
      if (email && previous?.account?.email && previous.account.email !== email) {
        console.log(`  What this machine synced to ${previous.account.email} stays there; ${email} gets everything else.`);
      }
      await reportDetectedLogs();
      console.log(FIELDS_SHOWN_ONCE);
      await runSetup({ interactive: process.stdin.isTTY === true });
      await offerPlugin({ interactive: isInteractiveTerminal() }, pluginDeps);
      console.log("");
      console.log("  Run `npx centrail sync` to push usage now. Codex, or Claude Code without the plugin:");
      console.log("  `npx centrail install-hooks` syncs after each turn.");
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
  if (Object.keys(state.surfaces).length === 0 && !state.lastSyncAt)
    return;
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
      const entries = await readdir4(dir);
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
import { mkdir as mkdir4, open, readdir as readdir5, rm as rm2, stat as stat8 } from "node:fs/promises";
import { dirname as dirname5, join as join10 } from "node:path";
var AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1e3;
function detectSurface(input, fallback) {
  if (typeof input.turn_id === "string" && input.turn_id)
    return "codex";
  const t = typeof input.transcript_path === "string" ? input.transcript_path.replace(/\\/g, "/") : "";
  if (/\/sessions\/.*rollout-[^/]*\.jsonl$/.test(t))
    return "codex";
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
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const cwd = typeof input.cwd === "string" ? input.cwd : "";
  if (!sessionId || !cwd)
    return null;
  surface = detectSurface(input, surface);
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
  const transcript = typeof input.transcript_path === "string" ? input.transcript_path : "";
  const previous = (await readSidecar(deps.sidecarPath)).get(sessionId);
  const roots = { ...previous?.roots ?? {} };
  const mains = { ...previous?.mains ?? {} };
  if (root && repo)
    await recordRoot(root, repo, roots, mains);
  if (transcript) {
    line.transcript = transcript;
    line.offset = await recordTouchedRoots(transcript, previous?.offset ?? 0, roots, mains, cwd);
    const subOffsets = { ...previous?.subOffsets ?? {} };
    for (const sub of await subagentTranscripts(transcript)) {
      subOffsets[sub] = await recordTouchedRoots(sub, subOffsets[sub] ?? 0, roots, mains, cwd);
    }
    if (Object.keys(subOffsets).length > 0)
      line.subOffsets = subOffsets;
  }
  if (Object.keys(roots).length > 0)
    line.roots = roots;
  if (Object.keys(mains).length > 0)
    line.mains = mains;
  await appendSidecar(line, deps.sidecarPath);
  await maybeAutoSync(now, deps, deps.claimPath ?? join10(dirname5(deps.sidecarPath ?? SIDECAR_PATH), "autosync.claim"));
  return line;
}
async function subagentTranscripts(transcript) {
  if (!transcript.endsWith(".jsonl"))
    return [];
  const dir = join10(transcript.slice(0, -".jsonl".length), "subagents");
  try {
    return (await readdir5(dir)).filter((f) => f.endsWith(".jsonl")).map((f) => join10(dir, f));
  } catch {
    return [];
  }
}
async function recordRoot(root, id, roots, mains) {
  if (roots[root])
    return;
  roots[root] = id;
  const main = await readMainCheckout(root);
  if (main)
    mains[root] = main;
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
    if (size <= offset)
      return size < offset ? 0 : offset;
    const length = Math.min(size - offset, MAX_BYTES_PER_TURN);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    const complete = buf.subarray(0, bytesRead).lastIndexOf(10);
    if (complete < 0)
      return offset;
    const lines = [];
    let turnCwd = cwd;
    for (let start = 0; start <= complete; ) {
      const nl = buf.indexOf(10, start);
      const raw = buf.toString("utf-8", start, nl);
      start = nl + 1;
      if (!raw.includes('"tool_use"') && !raw.includes('"function_call"') && !raw.includes('"turn_context"'))
        continue;
      let line;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isObject8(line))
        continue;
      let ev = null;
      if (line.type === "assistant" && isObject8(line.message))
        ev = lineEvidence(line.message);
      else if (line.type === "turn_context" && isObject8(line.payload) && typeof line.payload.cwd === "string")
        turnCwd = line.payload.cwd;
      else if (line.type === "response_item" && isObject8(line.payload) && line.payload.type === "function_call")
        ev = codexCallEvidence(line.payload.name, line.payload.arguments, turnCwd);
      if (!ev)
        continue;
      lines.push({ paths: [...ev.writes, ...ev.reads], end: start });
    }
    let spawned = 0;
    const seen = /* @__PURE__ */ new Set();
    for (let i = 0; i < lines.length; i++) {
      for (const path of lines[i].paths) {
        const dir = await nearestDirectory(path);
        if (!dir || seen.has(dir))
          continue;
        seen.add(dir);
        const known = deepestRoot(Object.keys(roots), path);
        if (known && !await nestedCheckout(known, dir))
          continue;
        if (spawned++ >= MAX_DIRS_PER_TURN)
          return offset + (i > 0 ? lines[i - 1].end : lines[i].end);
        const r = await resolveRepoRoot(dir);
        if (!r)
          continue;
        const id = roots[r] ?? await repoIdentity(r);
        if (!id)
          continue;
        await recordRoot(r, id, roots, mains);
        const alias = logicalRoot(dir, r);
        if (alias && !roots[alias])
          roots[alias] = id;
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
  if (!isWithin(physical, root))
    return null;
  const suffix = physical.slice(root.length);
  if (!dir.endsWith(suffix))
    return null;
  const logical = dir.slice(0, dir.length - suffix.length);
  return logical && logical !== root ? logical : null;
}
function isObject8(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
var CLOCK_STEP_MS = 60 * 1e3;
function shouldAutoSync(state, now) {
  if (!state.autoSyncAt)
    return true;
  const last = new Date(state.autoSyncAt).getTime();
  return Number.isNaN(last) || last - now.getTime() > CLOCK_STEP_MS || now.getTime() - last >= AUTO_SYNC_INTERVAL_MS;
}
async function maybeAutoSync(now, deps, claimPath) {
  const read = deps.readState ?? readState;
  const write = deps.writeState ?? writeState;
  const connected = deps.connected ?? (async () => await readAuth() !== null);
  const state = await read();
  if (!shouldAutoSync(state, now))
    return;
  if (!await connected() || hookParked(state)) {
    if (await claimAutoSync(claimPath, now))
      await compactLocked(now, deps);
    return;
  }
  if (!await claimAutoSync(claimPath, now))
    return;
  state.autoSyncAt = now.toISOString();
  await write(state);
  (deps.spawnSync ?? spawnDetachedSync)();
}
async function compactLocked(now, deps) {
  const release = await acquireSyncLock(deps.lockPath ?? join10(dirname5(deps.sidecarPath ?? SIDECAR_PATH), "sync.lock"));
  if (!release)
    return;
  try {
    await compactSidecar(deps.sidecarPath, now.getTime());
  } finally {
    await release();
  }
}
async function claimAutoSync(claimPath, now) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir4(claimPath, { recursive: false });
      return true;
    } catch (err) {
      const code = err.code;
      if (code === "ENOENT") {
        await mkdir4(dirname5(claimPath), { recursive: true });
        continue;
      }
      if (code !== "EEXIST")
        return false;
      let at;
      try {
        at = (await stat8(claimPath)).mtimeMs;
      } catch {
        continue;
      }
      if (!shouldAutoSync({ autoSyncAt: new Date(at).toISOString() }, now))
        return false;
      await rm2(claimPath, { recursive: true, force: true });
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
    env: process.env
  });
  child.unref();
}

// src/commands/import.ts
import { readFile as readFile9 } from "node:fs/promises";
var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
var MAX_MODEL = 100;
function parseCcusageExport(json) {
  if (!isObject9(json))
    throw new Error("Not a ccusage export: expected a JSON object");
  const merged = /* @__PURE__ */ new Map();
  const add = (day, breakdown) => {
    if (!isObject9(breakdown))
      throw new Error("Not a ccusage export: a model breakdown is not an object");
    if (typeof breakdown.modelName !== "string" || !breakdown.modelName)
      throw new Error("Not a ccusage export: a model breakdown has no modelName");
    const model = breakdown.modelName.slice(0, MAX_MODEL);
    const key = `${day}\0${model}`;
    const row = merged.get(key) ?? { day, model, inputTokens: 0, outputTokens: 0, contextTokens: 0 };
    row.inputTokens += count(breakdown.inputTokens);
    row.outputTokens += count(breakdown.outputTokens);
    row.contextTokens += count(breakdown.cacheReadTokens) + count(breakdown.cacheCreationTokens);
    merged.set(key, row);
  };
  if (Array.isArray(json.daily)) {
    for (const d of json.daily) {
      if (!isObject9(d) || typeof d.date !== "string" || !DAY_RE.test(d.date))
        throw new Error("Not a ccusage export: a daily row has no YYYY-MM-DD date");
      for (const b of Array.isArray(d.modelBreakdowns) ? d.modelBreakdowns : [])
        add(d.date, b);
    }
  } else if (Array.isArray(json.sessions)) {
    for (const s of json.sessions) {
      if (!isObject9(s) || typeof s.lastActivity !== "string" || Number.isNaN(Date.parse(s.lastActivity)))
        throw new Error("Not a ccusage export: a session has no lastActivity");
      const day = new Date(s.lastActivity).toISOString().slice(0, 10);
      for (const b of Array.isArray(s.modelBreakdowns) ? s.modelBreakdowns : [])
        add(day, b);
    }
  } else {
    throw new Error("Not a ccusage export: expected `daily` (ccusage claude daily --json) or `sessions` (ccusage claude session --json)");
  }
  return [...merged.values()];
}
function count(v) {
  if (v === void 0 || v === null)
    return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
    throw new Error("Not a ccusage export: a token count is not a non-negative integer");
  return v;
}
async function runImport(file, deps = {}) {
  const auth = await readAuth();
  if (!auth)
    throw new Error("Not connected \u2014 run `centrail connect` first");
  assertSecureBaseUrl(auth.baseUrl);
  let json;
  try {
    json = JSON.parse(await readFile9(file, "utf-8"));
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
  if (res.status === 401)
    throw new Error("Token revoked or expired \u2014 run `centrail connect`");
  if (!res.ok) {
    const b = await res.json().catch(() => null);
    throw new Error(`Import failed (${res.status})${b?.error ? `: ${b.error}` : ""}`);
  }
  const days = new Set(rows.map((r) => r.day));
  console.log(`Imported ${rows.length} day\xB7model row(s) over ${days.size} day(s) as Measured history (provider ccusage). A re-import replaces them.`);
}
function isObject9(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// src/device.ts
async function checkDevice(auth) {
  try {
    const res = await fetch(`${auth.baseUrl}/api/cli/device`, {
      headers: { authorization: `Bearer ${auth.token}`, ...versionHeaders() },
      signal: AbortSignal.timeout(5e3)
    });
    if (res.status === 401)
      return { kind: "refused", reason: await refusalReason(res) };
    if (!res.ok)
      return { kind: "unknown" };
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
  const outdated = stillTrue(state.outdated, at, state.outdated?.minimum);
  const notice = stillTrue(state.updateNotice, at, state.updateNotice?.latest);
  if (outdated)
    console.log(outdatedLine(outdated));
  if (notice && !(outdated && sameInstall(notice, outdated)))
    console.log(updateNoticeLine(notice));
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
  if (mode === "quiet")
    return false;
  if (mode === "verbose")
    return true;
  return isTTY && !env.CI;
}
function progress(message) {
  if (!progressEnabled())
    return;
  if (inline)
    process.stderr.write("\r\x1B[K");
  inline = false;
  stopStatus();
  process.stderr.write(`  ${message}
`);
}
function progressStatus(message) {
  if (!progressEnabled())
    return;
  const now = Date.now();
  const tty = process.stderr.isTTY === true;
  const phase = message.replace(/\d[\d,]*/g, "#");
  if (status?.phase === phase) {
    status.message = message;
    if (now - status.drawnAt < (tty ? REDRAW_MS : HEARTBEAT_MS))
      return;
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
  if (inline && progressEnabled())
    process.stderr.write("\r\x1B[K");
  inline = false;
  stopStatus();
}
function drawStatus(now) {
  if (!status)
    return;
  const secs = Math.floor((now - status.since) / 1e3);
  const age = secs < 1 ? "" : secs < 60 ? ` \xB7 ${secs}s` : ` \xB7 ${Math.floor(secs / 60)}m ${secs % 60}s`;
  process.stderr.write(`\r\x1B[K  ${status.message}${age}`);
  inline = true;
}
function stopStatus() {
  if (heartbeat)
    clearInterval(heartbeat);
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
      if (e.metadata.repo)
        continue;
      const sid = e.metadata.sessionId;
      if (!sid || !e.metadata.turn) {
        await this.resolver.stamp(e);
        continue;
      }
      let list = sessions.get(sid);
      if (!list)
        sessions.set(sid, list = []);
      list.push(e);
    }
    for (const list of sessions.values())
      await this.placeSession(list);
  }
  async placeSession(events) {
    events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const turns = /* @__PURE__ */ new Map();
    for (const e of events) {
      const id = e.metadata.turn;
      let t = turns.get(id);
      if (!t)
        turns.set(id, t = []);
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
        if (placement !== "folder")
          sticky = repo;
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
      if (!repo)
        continue;
      const v = votes.get(repo.key);
      if (v)
        v.n++;
      else
        votes.set(repo.key, { repo, n: 1 });
    }
    let best = null;
    for (const v of votes.values())
      if (!best || v.n > best.n)
        best = v;
    return best?.repo ?? null;
  }
};
function merge(a, b) {
  if (!b)
    return a;
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
    if (!res.ok)
      return fallback;
    const body = await res.json();
    const fields = Array.isArray(body.fields) ? body.fields.filter((f) => typeof f === "string") : [];
    const cli = parseCliVersions(body.cli);
    return { fields: new Set(fields), ...cli ? { cli } : {} };
  } catch {
    return fallback;
  }
}
function toWireEvent(e, caps, cfg, installId) {
  const wire = toWireUsageEvent(e);
  if (caps.fields.has("usage-extras")) {
    if (e.speed)
      wire.speed = e.speed;
    if (e.webSearchRequests)
      wire.webSearchRequests = e.webSearchRequests;
  }
  if (caps.fields.has("repo"))
    wire.metadata = identityMetadata(e, cfg, installId);
  return wire;
}
function identityMetadata(e, cfg, installId) {
  const metadata = { origin: { machineId: installId } };
  if (e.metadata.repo) {
    metadata.repo = wireIdentity(redactIdentity(e.metadata.repo, cfg, installId));
    if (e.metadata.placement)
      metadata.placement = e.metadata.placement;
  }
  if (e.metadata.sessionId)
    metadata.sessionId = e.metadata.sessionId;
  const branch = wireBranch(e.metadata.gitBranch, cfg);
  if (branch)
    metadata.gitBranch = branch;
  return metadata;
}
function wireIdentity(repo) {
  return { key: repo.key, label: repo.label, source: repo.source, ...repo.root ? { root: repo.root } : {} };
}
function redactIdentity(repo, cfg, installId) {
  if (!cfg.hideRepoNames)
    return repo;
  if (repo.source === "folder")
    return { key: repo.key, label: "", source: repo.source };
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
    if (f.row.mergedAs)
      wire.mergedAs = f.row.mergedAs;
    wire.committedAt = f.commit?.committedAt ?? "";
    wire.linesAdded = f.commit?.linesAdded ?? 0;
    wire.linesDeleted = f.commit?.linesDeleted ?? 0;
    wire.filesChanged = f.commit?.filesChanged ?? 0;
    if (f.mine !== void 0)
      wire.mine = f.mine;
  }
  if (caps.fields.has("patch-id")) {
    if (f.patchId)
      wire.patchId = f.patchId;
    if (f.branchPatchId)
      wire.branchPatchId = f.branchPatchId;
  }
  return wire;
}

// src/ship-status.ts
var FATE_CHUNK = 2e3;
var WINDOW_DAYS = 90;
var DAY_MS2 = 24 * 60 * 60 * 1e3;
async function gatherShipStatusFacts(repoRoot, now = /* @__PURE__ */ new Date(), withPatchIds = false) {
  const defaultBranch = await resolveDefaultBranch(repoRoot);
  if (!defaultBranch)
    return null;
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
    if (Number.isFinite(tipMs) && tipMs < cutoffMs)
      continue;
    branchTipDates[tip.name] = tip.tipDate;
    let unmerged = false;
    for (const sha of await listReachableShas(repoRoot, tip.ref, WINDOW_DAYS)) {
      if (!recent.has(sha))
        continue;
      (branchesBySha[sha] ??= []).push(tip.name);
      if (!ancestors.has(sha))
        unmerged = true;
    }
    if (unmerged && !isDefaultRef(tip.name))
      cherryCandidates.push(tip);
  }
  const tips = /* @__PURE__ */ new Map();
  for (const tip of cherryCandidates)
    if (!tips.has(tip.sha))
      tips.set(tip.sha, tip);
  const cherrySet = /* @__PURE__ */ new Set();
  const prefixes = [];
  for (const tip of tips.values()) {
    for (const sha of await cherryEquivalentShas(repoRoot, defaultBranch, tip.name)) {
      cherrySet.add(sha);
    }
    const prefix = await branchPrefixes(repoRoot, ancestryRef, tip.ref);
    if (prefix.length > 0)
      prefixes.push(prefix);
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
      if (recent.has(sha))
        squashedInto[sha] = into;
    }
  });
  const branchPatchIds = {};
  for (const [sha, id] of Object.entries(prefixIds)) {
    if (recent.has(sha) && !ancestors.has(sha))
      branchPatchIds[sha] = id;
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
    if (id)
      byId.set(id, sha);
  }
  for (let k = prefix.length; k >= 1; k--) {
    const id = cumulative[prefix[k - 1].sha];
    const into = id ? byId.get(id) : void 0;
    if (into)
      return Object.fromEntries(prefix.slice(0, k).map((c) => [c.sha, into]));
  }
  return {};
}
async function runFatePass(auth, repos, declared = [], machineId, caps = { fields: new Set(machineId ? ["repo"] : []) }, cfg = { hideBranchNames: false }) {
  let anyRepoPassed = false;
  const tally = { shipped: 0, inFlight: 0, unshipped: 0 };
  for (const [i, { root: one, roots: many, name, key }] of repos.entries()) {
    progressStatus(`Checking ship status \u2014 ${i + 1}/${repos.length} repos`);
    const roots = many ?? (one ? [one] : []);
    const facts = await gatherShipStatusFactsForRoots(roots, caps.fields.has("patch-id"));
    if (!facts)
      continue;
    anyRepoPassed = true;
    const root = roots[0];
    const email = await readUserEmail(root);
    const bySha = new Map(facts.shas.map((c) => [c.sha, c]));
    const ancestors = new Set(facts.ancestorShas);
    const rows = computeCommitFates(facts);
    const fates = [];
    for (const row of rows) {
      if (row.fate === "shipped")
        tally.shipped++;
      else if (row.fate === "in_flight")
        tally.inFlight++;
      else
        tally.unshipped++;
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
  if (!anyRepoPassed)
    return null;
  return tally;
}
async function gatherShipStatusFactsForRoots(roots, withPatchIds = false) {
  let merged = null;
  for (const root of roots) {
    const f = await gatherShipStatusFacts(root, /* @__PURE__ */ new Date(), withPatchIds);
    if (!f)
      continue;
    const complete = f.shas.length < RECENT_SHA_CAP;
    if (!merged) {
      merged = { ...f, complete };
      continue;
    }
    const seen = new Set(merged.shas.map((c) => c.sha));
    for (const c of f.shas)
      if (!seen.has(c.sha))
        merged.shas.push(c);
    merged.ancestorShas = [.../* @__PURE__ */ new Set([...merged.ancestorShas, ...f.ancestorShas])];
    merged.cherryEquivalentShas = [.../* @__PURE__ */ new Set([...merged.cherryEquivalentShas, ...f.cherryEquivalentShas])];
    merged.squashedInto = { ...merged.squashedInto ?? {}, ...f.squashedInto ?? {} };
    merged.patchIds = { ...merged.patchIds, ...f.patchIds };
    merged.branchPatchIds = { ...merged.branchPatchIds, ...f.branchPatchIds };
    for (const [sha, branches] of Object.entries(f.branchesBySha)) {
      merged.branchesBySha[sha] = [.../* @__PURE__ */ new Set([...merged.branchesBySha[sha] ?? [], ...branches])];
    }
    for (const [b, d] of Object.entries(f.branchTipDates))
      if (!(b in merged.branchTipDates))
        merged.branchTipDates[b] = d;
    merged.complete = merged.complete && complete;
  }
  return merged;
}
async function pushFates(auth, fates, repos, facts) {
  if (fates.length === 0)
    return;
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
      if (res.status === 426)
        throw new CliOutdatedError(await parkOutdated(await minimumFrom(res)));
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        console.warn(
          `  \u26A0 Ship-status chunk skipped (${res.status})${body?.error ? `: ${body.error}` : ""}.`
        );
      }
    }
  } catch (err) {
    if (err instanceof CliOutdatedError)
      throw err;
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
  const release = await acquireSyncLock();
  if (!release) {
    console.log("Another sync is already running on this machine \u2014 skipped.");
    return;
  }
  try {
    await syncLocked(opts);
  } finally {
    await release();
  }
}
async function syncLocked(opts) {
  const auth = await readAuth();
  if (!auth) {
    const parked = await readDisconnected();
    throw new Error(parked ? disconnectedMessage(parked) : "Not connected \u2014 run `centrail connect` first");
  }
  assertSecureBaseUrl(auth.baseUrl);
  const device = await checkDevice(auth);
  if (device.kind === "refused")
    await disconnect(device.reason);
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
  if (served.cli?.minimum && isOlder(at.version, served.cli.minimum))
    throw new CliOutdatedError(await parkOutdated(served.cli.minimum));
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
  let anyEvents = false;
  let anyWatermark = false;
  let heldByScope = 0;
  const attributionEvents = [];
  const full = opts.full || config.pendingBackfill;
  for (const scanner of SCANNERS) {
    if (!surfaceEnabled(config, scanner.surface))
      continue;
    const mark = full ? void 0 : sinceForSurface(state, scanner.surface, scanner.revision);
    if (mark)
      anyWatermark = true;
    const since = mark ? new Date(mark.getTime() - WATERMARK_OVERLAP_MS) : void 0;
    const scanStartedAt = /* @__PURE__ */ new Date();
    const reading = `${scanner.surface}: reading logs ${since ? `since ${since.toISOString().slice(0, 10)}` : "(full history)"}`;
    progressStatus(`${reading}\u2026`);
    const scanned = await scanner.scan({
      since,
      wholeFiles: true,
      onFile: (done, total) => progressStatus(`${reading} \u2014 ${done.toLocaleString("en-US")}/${total.toLocaleString("en-US")} files`)
    });
    const candidates = scanned.filter(
      (e) => !e.metadata.context && e.externalId.length > 0 && e.occurredAt >= minOccurredAt && e.occurredAt <= maxOccurredAt
    );
    progressStatus(`${scanner.surface}: finding the repo of ${scanned.length.toLocaleString("en-US")} events\u2026`);
    await placer.place(scanned);
    const events = candidates.filter((e) => eventInScope(e, config));
    heldByScope += candidates.length - events.length;
    if (events.length === 0) {
      progress(`${scanner.surface}: nothing new${candidates.length > 0 ? ` (${candidates.length.toLocaleString("en-US")} held back by scope)` : ""}`);
      await stampSurface(state, scanner.surface, scanner.revision, scanStartedAt);
      continue;
    }
    anyEvents = true;
    if (scanner.surface === "claude-code" || scanner.surface === "codex") {
      for (const e of events)
        attributionEvents.push(e);
    }
    let surfaceInserted = 0;
    let surfaceSkipped = 0;
    let surfaceHeld = 0;
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);
      progressStatus(`${scanner.surface}: sending ${Math.min(i + BATCH_SIZE, events.length).toLocaleString("en-US")} of ${events.length.toLocaleString("en-US")} events`);
      const body = {
        source: { surface: scanner.surface, kind: "local_logs" },
        events: batch.map((e) => toWireEvent(e, caps, config, installId))
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
      if (res.status === 401)
        await disconnect(await refusalReason(res));
      if (res.status === 426)
        throw new CliOutdatedError(await parkOutdated(await minimumFrom(res) ?? served.cli?.minimum));
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        throw new Error(
          `Sync failed for ${scanner.surface} (${res.status})${b?.error ? `: ${b.error}` : ""}`
        );
      }
      const result = await res.json();
      if (state.outdated && sameInstall(state.outdated, at))
        delete state.outdated;
      grandInserted += result.inserted;
      grandSkipped += result.skipped;
      grandInbox += result.inboxCount;
      const held = typeof result.heldElsewhere === "number" && result.heldElsewhere > 0 ? Math.min(result.heldElsewhere, result.skipped) : 0;
      grandHeldElsewhere += held;
      surfaceInserted += result.inserted;
      surfaceSkipped += result.skipped - held;
      surfaceHeld += held;
    }
    progress(
      `${scanner.surface}: ${surfaceInserted.toLocaleString("en-US")} new, ${surfaceSkipped.toLocaleString("en-US")} already synced` + (surfaceHeld > 0 ? `, ${surfaceHeld.toLocaleString("en-US")} with another account` : "")
    );
    if (!since)
      heldOnFullRead += surfaceHeld;
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
    if (notice)
      progress(updateNoticeLine(notice));
    return;
  }
  if (attributionEvents.length > 0) {
    progressStatus("Matching events to commits\u2026");
    await pushAttributions(auth, attributionEvents, resolver, config, caps, installId);
  }
  progressDone();
  console.log(
    `Inserted ${grandInserted} \xB7 Skipped ${grandSkipped - grandHeldElsewhere}` + // Projects are optional (2026-10 IA): a neutral count, not a queue to work.
    (grandInbox > 0 ? ` \xB7 ${grandInbox} not in a project` : "") + (heldByScope > 0 ? ` \xB7 ${heldByScope} held back by scope` : "")
  );
  if (heldOnFullRead > 0)
    console.log(heldElsewhereLine(heldOnFullRead));
  if (notice)
    progress(updateNoticeLine(notice));
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
    if (line.surface !== "claude-code" || !line.transcript)
      continue;
    const i = line.transcript.replace(/\\/g, "/").lastIndexOf("/projects/");
    if (i <= 0)
      continue;
    const dir = line.transcript.slice(0, i);
    if (!known.includes(dir) && !learned.includes(dir))
      learned.push(dir);
  }
  if (learned.length > 0)
    process.env.CLAUDE_CONFIG_DIR = [...known, ...learned].join(",");
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
    if (!b)
      buckets.set(id, b = { root, ref, name, key, events: [] });
    return b;
  };
  const orphans = [];
  for (const e of events) {
    const repo = e.metadata.repo;
    if (!repo || repo.source === "folder")
      continue;
    const root = await resolver.liveRootFor(e);
    if (!root) {
      orphans.push(e);
      continue;
    }
    const shown = wireRepoRef(repo, config, installId);
    bucket(root, "HEAD", shown.name, shown.key).events.push(e);
  }
  const rootByKey = /* @__PURE__ */ new Map();
  for (const b of buckets.values())
    if (!rootByKey.has(b.key))
      rootByKey.set(b.key, b.root);
  for (const e of orphans) {
    const repo = e.metadata.repo;
    const shown = wireRepoRef(repo, config, installId);
    let root = rootByKey.get(shown.key);
    if (!root) {
      const found = await resolver.liveRootForKey(repo.key);
      if (!found)
        continue;
      rootByKey.set(shown.key, root = found);
    }
    const branch = resolver.sidecarBranchFor(e);
    bucket(root, branch ? `refs/heads/${branch}` : "--all", shown.name, shown.key).events.push(e);
  }
  if (buckets.size === 0)
    return;
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
    if (serverMatches)
      continue;
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
        if (res.status === 426)
          throw new CliOutdatedError(await parkOutdated(await minimumFrom(res)));
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
      if (err instanceof CliOutdatedError)
        throw err;
      console.warn("  \u26A0 Attribution request failed:", err.message);
    }
  }
  const fateRepos = /* @__PURE__ */ new Map();
  for (const b of buckets.values()) {
    const id = identityAware ? b.key : b.root;
    const entry = fateRepos.get(id);
    if (!entry)
      fateRepos.set(id, { roots: [b.root], name: b.name, key: identityAware ? b.key : void 0 });
    else if (!entry.roots.includes(b.root))
      entry.roots.push(b.root);
  }
  const tally = await runFatePass(auth, [...fateRepos.values()], serverMatches ? repos : [], identityAware ? installId : void 0, caps, config);
  if (tally) {
    console.log(`  \u21B3 ${formatShipStatusLine(tally)}`);
  }
}

// src/index.ts
var [, , command, ...rest] = process.argv;
var flags = { url: void 0, full: false, last: false, noBrowser: false };
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--url")
    flags.url = rest[++i];
  else if (rest[i] === "--full")
    flags.full = true;
  else if (rest[i] === "--last")
    flags.last = true;
  else if (rest[i] === "--no-browser")
    flags.noBrowser = true;
  else if (rest[i] === "--quiet")
    setProgressMode("quiet");
  else if (rest[i] === "--verbose")
    setProgressMode("verbose");
}
var USAGE = `centrail \u2014 sync local AI agent usage to centrail.org

Usage:
  centrail connect [--url <base>]   Pair this machine with your account (opens your browser; --no-browser)
  centrail status                   Which account this machine syncs to, and whether its pairing still works
  centrail sync [--full]            Push new usage events (--full rescans everything)
                                    Progress shows in a terminal; --quiet hides it, --verbose forces it
  centrail setup-plugin             Auto-sync in Claude Code: install its plugin and let Claude Code update it (asked at connect)
  centrail install-hooks            Auto-sync without the plugin: a Stop hook for Codex (and Claude Code)
  centrail uninstall-hooks          Remove that hook
  centrail inspect --last           Print the last payload exactly as it left this machine
  centrail setup                    Review which repos and folders sync (asked once at connect)
  centrail repos                    List them with status
  centrail exclude <repo>           Nothing about this repo leaves (host/owner/repo or folder name)
  centrail include <repo>           Undo an exclude; in allow mode, add it
  centrail surfaces [<name> on|off] Enable or disable a source (claude-code, codex, copilot-cli)
  centrail import <ccusage.json>    Import a ccusage "claude daily/session --json" file as Measured history
  centrail hook stop                (run by the agent's Stop hook; reads JSON on stdin)
`;
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin)
    chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}
try {
  if (command !== "hook" && isInteractiveTerminal())
    await recordNode();
  if (command === "connect") {
    await runConnect({ baseUrl: flags.url, noBrowser: flags.noBrowser });
  } else if (command === "status") {
    await runStatus();
  } else if (command === "sync") {
    await runSync({ full: flags.full });
  } else if (command === "setup-plugin") {
    await offerPlugin({ interactive: isInteractiveTerminal(), again: true });
  } else if (command === "install-hooks") {
    await runInstallHooks({ remove: false });
  } else if (command === "uninstall-hooks") {
    await runInstallHooks({ remove: true });
  } else if (command === "inspect") {
    await runInspect();
  } else if (command === "hook") {
    try {
      await runStopHook(await readStdin(), "claude-code");
    } catch {
    }
  } else if (command === "setup") {
    await runSetup({ interactive: true });
  } else if (command === "repos") {
    await runRepos();
  } else if (command === "exclude" || command === "include") {
    const name = rest[0];
    if (!name) {
      console.error(`Usage: centrail ${command} <repo>`);
      process.exit(1);
    }
    if (command === "exclude")
      await runExclude(name);
    else
      await runInclude(name);
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
