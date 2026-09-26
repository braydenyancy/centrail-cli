#!/usr/bin/env node

// src/commands/connect.ts
import { readdir as readdir4 } from "node:fs/promises";
import { hostname as hostname3, platform as platform3 } from "node:os";

// ../parsers/src/providers/claude-code.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
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
var BASH_PATH = /(?:^|[\s=:;|&(<>'"`])(?:'(\/[^']+)'|"(\/[^"]+)"|(\/[^\s'"`;|&<>()]+))/g;
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
function claudeAccountFiles() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  const files = [];
  if (env && env.trim()) {
    for (const d of env.split(",").map((s) => s.trim()).filter(Boolean)) {
      files.push(join2(d, ".claude.json"));
    }
  }
  files.push(join2(homedir(), ".claude.json"));
  return files;
}
async function readAccountFile(filePath) {
  try {
    const content = await readFile(filePath, "utf-8");
    const json = JSON.parse(content);
    const acct = json.oauthAccount;
    if (!isObject2(acct))
      return null;
    return {
      accountUuid: stringOr(acct.accountUuid),
      emailAddress: stringOr(acct.emailAddress),
      organizationUuid: stringOr(acct.organizationUuid),
      billingType: stringOr(acct.billingType)
    };
  } catch {
    return null;
  }
}
async function readClaudeCodeAccount(filePath) {
  const candidates = filePath ? [filePath] : claudeAccountFiles();
  for (const p of candidates) {
    const acct = await readAccountFile(p);
    if (acct)
      return acct;
  }
  return null;
}
async function scanClaudeCodeLogs(opts) {
  const since = opts.since;
  const host = hostname();
  const plat = platform();
  const bases = opts.basePath ? [opts.basePath] : claudeProjectDirs();
  const events = [];
  for (const base of bases) {
    for (const e of await scanProjectsDir(base, since, host, plat))
      events.push(e);
  }
  return collapseUsageEvents(foldSidechainReplays(events));
}
function foldSidechainReplays(events) {
  const parentId = /* @__PURE__ */ new Map();
  for (const e of events) {
    const m = e.metadata;
    if (m.sidechain || !m.messageId)
      continue;
    const k = `${m.sessionId ?? ""}\0${m.messageId}`;
    if (!parentId.has(k))
      parentId.set(k, e.externalId);
  }
  for (const e of events) {
    const m = e.metadata;
    if (!m.sidechain || !m.messageId)
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
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
  return `msg:${messageId}:${sessionId}`;
}
async function scanProjectsDir(basePath, since, host, plat) {
  let entries;
  try {
    entries = await readdir(basePath);
  } catch (err) {
    if (err.code === "ENOENT")
      return [];
    throw err;
  }
  const events = [];
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
      let content;
      try {
        content = await readFile(path, "utf-8");
      } catch {
        continue;
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
        const parsed = parseAssistantEvent(raw, host, plat, turns.current);
        if (parsed && (!since || parsed.occurredAt > since)) {
          applyFallback(raw, parsed);
          events.push(parsed);
          for (const extra of extraIterations(raw, parsed))
            events.push(extra);
        }
      }
    }
  }
  return events;
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
    for (const f of await jsonlUnder(join2(dir, entry.name, "subagents"), 4))
      files.push(f);
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
async function jsonlUnder(dir, depth) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".jsonl"))
      out.push(join2(dir, e.name));
    else if (e.isDirectory() && depth > 0)
      for (const f of await jsonlUnder(join2(dir, e.name), depth - 1))
        out.push(f);
  }
  return out;
}
function parseAssistantEvent(raw, host, plat, turn) {
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
    metadata: {
      cwd: stringOr(raw.cwd),
      gitBranch: stringOr(raw.gitBranch),
      sessionId: stringOr(raw.sessionId),
      version,
      entrypoint,
      turn,
      touched: lineEvidence(message),
      messageId: stringOr(message.id),
      sidechain: raw.isSidechain === true,
      origin: {
        host,
        platform: plat,
        client: entrypoint,
        clientVersion: version
      }
    }
  };
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
  const since = opts.since;
  let entries;
  try {
    entries = await readdir2(basePath);
  } catch (err) {
    if (err.code === "ENOENT")
      return [];
    throw err;
  }
  const events = [];
  for (const entry of entries) {
    const dir = join3(basePath, entry);
    let dirStat;
    try {
      dirStat = await stat2(dir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory())
      continue;
    const ws = await readWorkspace(join3(dir, "workspace.yaml"));
    if (!ws)
      continue;
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
            sessionId,
            origin: { host: "", platform: "", client: "copilot-cli" }
          }
        });
      }
    }
  }
  return suffixDuplicateExternalIds(events);
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
import { homedir as homedir3, hostname as hostname2, platform as platform2 } from "node:os";
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
  const host = hostname2();
  const plat = platform2();
  const events = [];
  const metaByPath = /* @__PURE__ */ new Map();
  for (const path of files)
    metaByPath.set(path, await readForkMeta(path));
  const pathBySession = /* @__PURE__ */ new Map();
  for (const [path, m] of metaByPath)
    if (m.sessionId && !pathBySession.has(m.sessionId))
      pathBySession.set(m.sessionId, path);
  const parents = /* @__PURE__ */ new Map();
  for (const path of files) {
    if (opts.since) {
      try {
        if ((await stat3(path)).mtime < opts.since)
          continue;
      } catch {
        continue;
      }
    }
    let parsed = await parseSession(path, void 0, host, plat);
    const fork = metaByPath.get(path);
    if (fork?.forkedFrom)
      parsed = await dropForkReplay(parsed, fork, pathBySession.get(fork.forkedFrom), parents, host, plat);
    for (const e of parsed)
      if (!opts.since || e.occurredAt > opts.since)
        events.push(e);
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
async function dropForkReplay(child, fork, parentPath, parents, host, plat) {
  if (parentPath) {
    let parent = parents.get(parentPath);
    if (!parent) {
      parent = await parseSession(parentPath, void 0, host, plat);
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
async function parseSession(path, since, host, plat) {
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
    const parsed = parseTokenCount(raw, context, previousTotals, baselineValid, host, plat);
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
function parseTokenCount(raw, context, previousTotals, baselineValid, host, plat) {
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
        touched: context.touched ? { writes: [...context.touched.writes], reads: [...context.touched.reads] } : { writes: [], reads: [] },
        origin: {
          host,
          platform: plat,
          client: context.client ?? "codex",
          clientVersion: context.clientVersion
        }
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
    scan: (opts) => scanClaudeCodeLogs(opts),
    readAccount: () => readClaudeCodeAccount()
  },
  {
    surface: "copilot-cli",
    scan: (opts) => scanCopilotLogs(opts)
  },
  {
    surface: "codex",
    scan: (opts) => scanCodexLogs(opts)
  }
];

// src/config.ts
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile as readFile4, rename, rm, stat as stat4, writeFile } from "node:fs/promises";
import { homedir as homedir4 } from "node:os";
import { join as join5 } from "node:path";

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
  return {
    lastSyncAt: typeof obj.lastSyncAt === "string" ? obj.lastSyncAt : null,
    surfaces,
    ...typeof obj.autoSyncAt === "string" ? { autoSyncAt: obj.autoSyncAt } : {},
    ...Array.isArray(obj.capabilities) ? { capabilities: obj.capabilities.filter((f) => typeof f === "string") } : {}
  };
}
function sinceForSurface(state, surface) {
  const own = state.surfaces[surface];
  if (own)
    return validDate(own);
  if (state.lastSyncAt && SHARED_WATERMARK_SURFACES.has(surface)) {
    return validDate(state.lastSyncAt);
  }
  return void 0;
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
var STATE_PATH = join5(CONFIG_DIR, "state.json");
async function readAuth() {
  try {
    const raw = JSON.parse(await readFile4(AUTH_PATH, "utf-8"));
    if (typeof raw.baseUrl !== "string" || typeof raw.token !== "string" || typeof raw.deviceName !== "string") {
      return null;
    }
    return {
      baseUrl: raw.baseUrl,
      token: raw.token,
      deviceName: raw.deviceName
    };
  } catch {
    return null;
  }
}
async function writeJsonAtomic(path, value, mode) {
  await mkdir(CONFIG_DIR, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}
`, mode === void 0 ? {} : { mode });
  await rename(tmp, path);
}
async function writeAuth(auth) {
  await writeJsonAtomic(AUTH_PATH, auth, 384);
  await chmod(AUTH_PATH, 384);
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
var LOCK_PATH = join5(CONFIG_DIR, "sync.lock");
var LOCK_STALE_MS = 15 * 60 * 1e3;
async function acquireSyncLock(lockPath = LOCK_PATH) {
  await mkdir(join5(lockPath, ".."), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lockPath);
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (err) {
      if (err.code !== "EEXIST")
        throw err;
      let ageMs;
      try {
        ageMs = Date.now() - (await stat4(lockPath)).mtimeMs;
      } catch {
        continue;
      }
      if (ageMs < LOCK_STALE_MS)
        return null;
      await rm(lockPath, { recursive: true, force: true });
    }
  }
  return null;
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
  hideBranchNames: false
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
    hideBranchNames: o.hideBranchNames === true
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

// src/commands/scope.ts
import { createInterface } from "node:readline/promises";

// src/resolver.ts
import { stat as stat6 } from "node:fs/promises";

// src/git.ts
import { execFile, spawn } from "node:child_process";
import { readFile as readFile5, stat as stat5 } from "node:fs/promises";
import { basename as basename2, dirname } from "node:path";
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
  return execFileAsync(cmd, args, { ...opts, env: gitEnv() });
}
function gitExec(args, opts = {}) {
  return exec("git", args, opts);
}
async function resolveRepoRoot(cwd) {
  try {
    const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
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
async function readMainCheckout(repoRoot) {
  try {
    const { stdout } = await exec("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const common = stdout.trim();
    if (!common || basename2(common) !== ".git")
      return null;
    const main = dirname(common);
    return main === repoRoot ? null : main;
  } catch {
    return null;
  }
}
async function readRepoCommits(repoRoot, ref = "HEAD") {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", repoRoot, "log", ref, "--numstat", "--pretty=format:%x1e%H%x1f%cI", "--"],
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
async function squashedShas(repoRoot, defaultRef, tipRef) {
  try {
    const { stdout: baseOut } = await exec("git", ["-C", repoRoot, "merge-base", defaultRef, tipRef]);
    const base = baseOut.trim();
    if (!base)
      return {};
    const { stdout: branchOut } = await exec("git", ["-C", repoRoot, "rev-list", "--reverse", `--max-count=${SQUASH_PREFIX_CAP}`, "--pretty=format:%H%x1f%cI", `${base}..${tipRef}`]);
    const branch = branchOut.split("\n").filter((l) => !l.startsWith("commit ") && l.includes("")).map((l) => l.split("")).map(([sha, iso]) => ({ sha: sha.trim(), at: iso.trim() }));
    if (branch.length === 0)
      return {};
    const { stdout: candOut } = await exec("git", ["-C", repoRoot, "rev-list", `--max-count=${SQUASH_CANDIDATE_CAP}`, `--since=${branch[0].at}`, `${base}..${defaultRef}`]);
    const candidates = candOut.split("\n").map((l) => l.trim()).filter(Boolean);
    if (candidates.length === 0)
      return {};
    const byPatchId = /* @__PURE__ */ new Map();
    for (const sha of candidates) {
      const { stdout: diff } = await exec("git", ["-C", repoRoot, "diff-tree", "-p", "--root", sha], { maxBuffer: FACT_BUFFER });
      const id = await patchId(repoRoot, diff);
      if (id && !byPatchId.has(id))
        byPatchId.set(id, sha);
    }
    for (let k = branch.length; k >= 1; k--) {
      const { stdout: diff } = await exec("git", ["-C", repoRoot, "diff", base, branch[k - 1].sha], { maxBuffer: FACT_BUFFER });
      if (!diff.trim())
        continue;
      const id = await patchId(repoRoot, diff);
      const into = id ? byPatchId.get(id) : void 0;
      if (!into)
        continue;
      const out = {};
      for (const b of branch.slice(0, k))
        out[b.sha] = into;
      return out;
    }
    return {};
  } catch {
    return {};
  }
}
function patchId(repoRoot, diff) {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", repoRoot, "patch-id", "--stable"], { env: gitEnv() });
    let out = "";
    child.stdout.on("data", (d) => out += d);
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(out.trim().split(/\s+/)[0] || null));
    child.stdin.end(diff);
  });
}
async function listRecentShas(repoRoot, sinceDays = 90) {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", repoRoot, "log", "--all", `--since=${sinceDays} days ago`, "--numstat", "--pretty=format:%x1e%H%x1f%cI%x1f%ae"],
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
import { realpathSync } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { readFile as readFile6 } from "node:fs/promises";
import { basename as basename3, dirname as dirname2, join as join6 } from "node:path";
function remoteKey(url) {
  const raw = url.trim();
  if (!raw)
    return null;
  let host;
  let path;
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
  }
  host = host.toLowerCase();
  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!host || !path || host === "localhost")
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
    const { stdout } = await gitExec(["-C", repoRoot, "rev-list", "--max-parents=0", ref]);
    return stdout.split("\n").map((s) => s.trim()).filter((s) => /^[0-9a-f]{40,64}$/.test(s)).sort();
  } catch {
    return [];
  }
}
function displayLabel(path) {
  const p = path.replace(/[\/\\]+$/, "");
  const home = homedir5().replace(/[\/\\]+$/, "");
  if (p === home)
    return "~";
  try {
    if (realpathSync(p) === realpathSync(home))
      return "~";
  } catch {
  }
  return basename3(p);
}
async function repoIdentity(repoRoot) {
  const label = displayLabel(repoRoot);
  const remote = await readRemoteKey(repoRoot);
  if (remote)
    return { key: remote, label, source: "remote" };
  const root = await readRootSha(repoRoot);
  if (root)
    return { key: `sha:${root}`, label, source: "root" };
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
      const text = await readFile6(join6(d, ".git"), "utf-8");
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
import { appendFile, mkdir as mkdir2, readFile as readFile7, rename as rename2, writeFile as writeFile2 } from "node:fs/promises";
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
    if (new Date(line.ts).getTime() >= cutoff)
      recent.push(raw);
    else
      keep.set(line.sessionId, raw);
  }
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile2(tmp, [...keep.values(), ...recent].map((l) => `${l}
`).join(""), { mode: 384 });
  await rename2(tmp, path);
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
  // the path's directory. Null for a path in no repo.
  async identityForPath(path, sessionId) {
    const roots = sessionId ? this.sidecar.get(sessionId)?.roots : void 0;
    if (roots) {
      let best = null;
      for (const root2 of Object.keys(roots)) {
        if ((path === root2 || path.startsWith(`${root2}/`)) && (!best || root2.length > best.length))
          best = root2;
      }
      if (best)
        return roots[best];
    }
    for (const root2 of this.liveRoots) {
      if (path === root2 || path.startsWith(`${root2}/`))
        return this.identityForRoot(root2);
    }
    const dir = await nearestDirectory(path);
    if (!dir)
      return null;
    const root = await this.rootFor(dir);
    return root ? this.identityForRoot(root) : null;
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
    const status = repoStatus({ key: r.key, label: r.labels[0] ?? "", source: r.source }, cfg);
    const mark = status === "synced" ? "\u2713" : status === "excluded" ? "\u2717" : "\u2026";
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
  const cfg = await readConfig();
  console.log("  Scanning local agent logs\u2026");
  const rows = await discoverRepos();
  printScope(rows, cfg);
  if (rows.length === 0 || !opts.interactive) {
    if (!cfg.scopeDecidedAt) {
      cfg.scopeDecidedAt = (/* @__PURE__ */ new Date()).toISOString();
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
  cfg.scopeDecidedAt = (/* @__PURE__ */ new Date()).toISOString();
  await writeConfig(cfg);
  console.log("");
  printScope(rows, cfg);
  console.log("  Saved. Change any time: `centrail exclude <repo>`, `centrail include <repo>`, `centrail repos`.");
}
async function runRepos() {
  const cfg = await readConfig();
  printScope(await discoverRepos(), cfg);
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

// src/version.ts
var CLI_VERSION = "0.6.0";
var WIRE_VERSION = "1";
function versionHeaders() {
  return {
    "centrail-cli-version": CLI_VERSION,
    "centrail-wire": WIRE_VERSION
  };
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
async function runConnect(opts) {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  assertSecureBaseUrl(baseUrl);
  const res = await fetch(`${baseUrl}/api/cli/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", ...versionHeaders() },
    body: JSON.stringify({ hostname: hostname3(), platform: platform3() })
  });
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
      await writeAuth({
        baseUrl,
        token: body.token,
        deviceName: hostname3()
      });
      console.log(`  \u2713 Paired (this machine: ${hostname3()})`);
      await reportDetectedLogs();
      console.log(FIELDS_SHOWN_ONCE);
      await runSetup({ interactive: process.stdin.isTTY === true });
      console.log("");
      console.log("  Run `npx centrail sync` to push usage, and `npx centrail install-hooks`");
      console.log("  so Claude Code syncs by itself after each turn.");
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
    tokens per model, timestamps, agent + version, OS family, session id,
    repo identity (host/owner/repo or a root-commit hash), folder name,
    branch, commit shas and line counts, a random per-install machine id.
  Never: source, prompts, completions, secrets, home-directory paths, hostname.
  Verify any time:  npx centrail inspect --last
  Toggles in ~/.config/centrail/config.json: hideRepoNames, hideBranchNames.
`;

// src/commands/hook.ts
import { spawn as spawn2 } from "node:child_process";
import { realpathSync as realpathSync2 } from "node:fs";
import { mkdir as mkdir3, open, readdir as readdir5, rm as rm2, stat as stat7 } from "node:fs/promises";
import { dirname as dirname4, join as join7 } from "node:path";
var AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1e3;
function detectSurface(input, fallback) {
  if (typeof input.turn_id === "string" && input.turn_id)
    return "codex";
  const t = typeof input.transcript_path === "string" ? input.transcript_path : "";
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
  await maybeAutoSync(now, deps, deps.claimPath ?? join7(dirname4(deps.sidecarPath ?? SIDECAR_PATH), "autosync.claim"));
  return line;
}
async function subagentTranscripts(transcript) {
  if (!transcript.endsWith(".jsonl"))
    return [];
  const dir = join7(transcript.slice(0, -".jsonl".length), "subagents");
  try {
    return (await readdir5(dir)).filter((f) => f.endsWith(".jsonl")).map((f) => join7(dir, f));
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
    const text = buf.toString("utf-8", 0, bytesRead);
    const complete = text.lastIndexOf("\n");
    if (complete < 0)
      return offset;
    const dirs = /* @__PURE__ */ new Set();
    let turnCwd = cwd;
    for (const raw of text.slice(0, complete).split("\n")) {
      if (!raw.includes('"tool_use"') && !raw.includes('"function_call"') && !raw.includes('"turn_context"'))
        continue;
      let line;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isObject6(line))
        continue;
      let ev = null;
      if (line.type === "assistant" && isObject6(line.message))
        ev = lineEvidence(line.message);
      else if (line.type === "turn_context" && isObject6(line.payload) && typeof line.payload.cwd === "string")
        turnCwd = line.payload.cwd;
      else if (line.type === "response_item" && isObject6(line.payload) && line.payload.type === "function_call")
        ev = codexCallEvidence(line.payload.name, line.payload.arguments, turnCwd);
      if (!ev)
        continue;
      for (const path of [...ev.writes, ...ev.reads])
        dirs.add(path);
    }
    let spawned = 0;
    const seen = /* @__PURE__ */ new Set();
    for (const path of dirs) {
      if (Object.keys(roots).some((r2) => path === r2 || path.startsWith(`${r2}/`)))
        continue;
      const dir = await nearestDirectory(path);
      if (!dir || seen.has(dir))
        continue;
      seen.add(dir);
      if (spawned++ >= MAX_DIRS_PER_TURN)
        break;
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
    return offset + complete + 1;
  } finally {
    await fh.close();
  }
}
function logicalRoot(dir, root) {
  let physical;
  try {
    physical = realpathSync2(dir);
  } catch {
    return null;
  }
  if (physical !== root && !physical.startsWith(`${root}/`))
    return null;
  const suffix = physical.slice(root.length);
  if (!dir.endsWith(suffix))
    return null;
  const logical = dir.slice(0, dir.length - suffix.length);
  return logical && logical !== root ? logical : null;
}
function isObject6(v) {
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
  if (!await connected())
    return;
  if (!await claimAutoSync(claimPath, now))
    return;
  state.autoSyncAt = now.toISOString();
  await write(state);
  (deps.spawnSync ?? spawnDetachedSync)();
}
async function claimAutoSync(claimPath, now) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir3(claimPath, { recursive: false });
      return true;
    } catch (err) {
      const code = err.code;
      if (code === "ENOENT") {
        await mkdir3(dirname4(claimPath), { recursive: true });
        continue;
      }
      if (code !== "EEXIST")
        return false;
      let at;
      try {
        at = (await stat7(claimPath)).mtimeMs;
      } catch {
        continue;
      }
      if (!shouldAutoSync({ lastSyncAt: null, surfaces: {}, autoSyncAt: new Date(at).toISOString() }, now))
        return false;
      await rm2(claimPath, { recursive: true, force: true });
    }
  }
  return false;
}
function spawnDetachedSync() {
  const child = spawn2(process.execPath, [process.argv[1], "sync"], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
}

// src/commands/hooks-install.ts
import { realpathSync as realpathSync3 } from "node:fs";
import { mkdir as mkdir4, readFile as readFile8, rename as rename3, writeFile as writeFile3 } from "node:fs/promises";
import { dirname as dirname5, join as join8 } from "node:path";
import { stat as stat8 } from "node:fs/promises";
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
  const hooks = isObject7(settings.hooks) ? { ...settings.hooks } : {};
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  const kept = stop.filter((g) => !isCentrailGroup(g));
  kept.push({ hooks: [{ type: "command", command: command2, timeout: 10 }] });
  return { ...settings, hooks: { ...hooks, Stop: kept } };
}
function uninstallStopHook(settings) {
  if (!isObject7(settings.hooks) || !Array.isArray(settings.hooks.Stop))
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
    const settings = await readSettings(target);
    const next = opts.remove ? uninstallStopHook(settings) : installStopHook(settings, hookCommand());
    await writeSettings(target, next);
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
    return (await stat8(p)).isDirectory();
  } catch {
    return false;
  }
}
function isCentrailGroup(g) {
  return isObject7(g) && Array.isArray(g.hooks) && g.hooks.some(
    (h) => isObject7(h) && typeof h.command === "string" && h.command.includes("centrail") && h.command.includes(HOOK_MARK)
  );
}
async function readSettings(path) {
  try {
    const parsed = JSON.parse(await readFile8(path, "utf-8"));
    return isObject7(parsed) ? parsed : {};
  } catch (err) {
    if (err.code === "ENOENT")
      return {};
    throw new Error(`Cannot parse ${path}: ${err.message}`);
  }
}
async function writeSettings(path, settings) {
  await mkdir4(dirname5(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile3(tmp, `${JSON.stringify(settings, null, 2)}
`);
  await rename3(tmp, path);
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
function isObject7(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// src/commands/import.ts
import { readFile as readFile9 } from "node:fs/promises";
var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
var MAX_MODEL = 100;
function parseCcusageExport(json) {
  if (!isObject8(json))
    throw new Error("Not a ccusage export: expected a JSON object");
  const merged = /* @__PURE__ */ new Map();
  const add = (day, breakdown) => {
    if (!isObject8(breakdown))
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
      if (!isObject8(d) || typeof d.date !== "string" || !DAY_RE.test(d.date))
        throw new Error("Not a ccusage export: a daily row has no YYYY-MM-DD date");
      for (const b of Array.isArray(d.modelBreakdowns) ? d.modelBreakdowns : [])
        add(d.date, b);
    }
  } else if (Array.isArray(json.sessions)) {
    for (const s of json.sessions) {
      if (!isObject8(s) || typeof s.lastActivity !== "string" || Number.isNaN(Date.parse(s.lastActivity)))
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
function isObject8(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
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

// src/ship-status.ts
var FATE_CHUNK = 2e3;
var WINDOW_DAYS = 90;
var DAY_MS2 = 24 * 60 * 60 * 1e3;
async function gatherShipStatusFacts(repoRoot, now = /* @__PURE__ */ new Date()) {
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
  const cherrySet = /* @__PURE__ */ new Set();
  const squashedInto = {};
  for (const tip of cherryCandidates) {
    for (const sha of await cherryEquivalentShas(repoRoot, defaultBranch, tip.name)) {
      cherrySet.add(sha);
    }
    for (const [sha, into] of Object.entries(await squashedShas(repoRoot, ancestryRef, tip.ref))) {
      if (recent.has(sha))
        squashedInto[sha] = into;
    }
  }
  return {
    defaultBranch,
    shas,
    ancestorShas,
    cherryEquivalentShas: [...cherrySet],
    squashedInto,
    branchesBySha,
    branchTipDates,
    now: now.toISOString()
  };
}
async function runFatePass(auth, repos, declared = [], machineId = "") {
  let anyRepoPassed = false;
  const tally = { shipped: 0, inFlight: 0, unshipped: 0 };
  for (const { root: one, roots: many, name, key } of repos) {
    const roots = many ?? (one ? [one] : []);
    const facts = await gatherShipStatusFactsForRoots(roots);
    if (!facts)
      continue;
    anyRepoPassed = true;
    const root = roots[0];
    const email = await readUserEmail(root);
    const bySha = new Map(facts.shas.map((c) => [c.sha, c]));
    const rows = computeCommitFates(facts);
    const fates = [];
    for (const row of rows) {
      if (row.fate === "shipped")
        tally.shipped++;
      else if (row.fate === "in_flight")
        tally.inFlight++;
      else
        tally.unshipped++;
      const c = bySha.get(row.sha);
      const mine = email && c?.authorEmail ? c.authorEmail === email : void 0;
      fates.push({
        repoName: name,
        ...key ? { repoKey: key } : {},
        commitSha: row.sha,
        branch: row.branch,
        fate: row.fate,
        ...row.mergedAs ? { mergedAs: row.mergedAs } : {},
        committedAt: c?.committedAt ?? "",
        linesAdded: c?.linesAdded ?? 0,
        linesDeleted: c?.linesDeleted ?? 0,
        filesChanged: c?.filesChanged ?? 0,
        ...mine === void 0 ? {} : { mine }
      });
    }
    const own = declared.filter((r) => key && r.key === key || r.name === name);
    await pushFates(auth, fates, own, { machineId, complete: facts.complete });
  }
  if (!anyRepoPassed)
    return null;
  return tally;
}
async function gatherShipStatusFactsForRoots(roots) {
  let merged = null;
  for (const root of roots) {
    const f = await gatherShipStatusFacts(root);
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
        body: JSON.stringify({ repos, attributions: [], fates: chunk, facts })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        console.warn(
          `  \u26A0 Ship-status chunk skipped (${res.status})${body?.error ? `: ${body.error}` : ""}.`
        );
      }
    }
  } catch (err) {
    console.warn("  \u26A0 Ship-status request failed:", err.message);
  }
}
function formatShipStatusLine(tally) {
  return `ship status: ${tally.shipped} shipped / ${tally.inFlight} in flight / ${tally.unshipped} unshipped`;
}

// src/wire.ts
import { createHmac as createHmac2 } from "node:crypto";
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
    return { fields: new Set(fields) };
  } catch {
    return fallback;
  }
}
function toWireEvent(e, caps, cfg, installId) {
  const identityAware = caps.fields.has("repo");
  const origin = e.metadata.origin;
  const metadata = {
    sessionId: e.metadata.sessionId,
    version: e.metadata.version,
    entrypoint: e.metadata.entrypoint
  };
  if (!cfg.hideBranchNames)
    metadata.gitBranch = e.metadata.gitBranch;
  if (identityAware) {
    if (e.metadata.repo) {
      metadata.repo = redactIdentity(e.metadata.repo, cfg, installId);
      if (e.metadata.placement)
        metadata.placement = e.metadata.placement;
    }
    if (origin) {
      metadata.origin = {
        platform: origin.platform,
        client: origin.client,
        clientVersion: origin.clientVersion,
        machineId: installId
      };
    }
  } else {
    metadata.cwd = e.metadata.cwd;
    if (origin)
      metadata.origin = origin;
  }
  return { ...e, occurredAt: e.occurredAt.toISOString(), metadata };
}
function redactIdentity(repo, cfg, installId) {
  if (!cfg.hideRepoNames || repo.source === "folder")
    return repo;
  const digest = createHmac2("sha256", installId).update(repo.key).digest("hex").slice(0, 16);
  return { key: `hidden:${digest}`, label: "", source: repo.source };
}

// src/commands/sync.ts
var BATCH_SIZE = 250;
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
    throw new Error("Not connected \u2014 run `centrail connect` first");
  }
  assertSecureBaseUrl(auth.baseUrl);
  const state = await readState();
  const config = await readConfig();
  if (!config.scopeDecidedAt) {
    config.scopeDecidedAt = (/* @__PURE__ */ new Date()).toISOString();
    await writeConfig(config);
  }
  const installId = await ensureInstallId();
  const caps = await readCapabilities(auth, state.capabilities ? { fields: new Set(state.capabilities) } : void 0);
  const capsNow = [...caps.fields].sort();
  if (JSON.stringify(capsNow) !== JSON.stringify(state.capabilities ?? [])) {
    state.capabilities = capsNow;
    await writeState(state);
  }
  await compactSidecar();
  await learnConfigDirs();
  const resolver = await IdentityResolver.create(installId);
  const placer = new Placer(resolver);
  const minOccurredAt = /* @__PURE__ */ new Date("2020-01-01T00:00:00.000Z");
  const maxOccurredAt = new Date(Date.now() + 24 * 60 * 60 * 1e3);
  let grandInserted = 0;
  let grandSkipped = 0;
  let grandInbox = 0;
  let anyEvents = false;
  let anyWatermark = false;
  let heldByScope = 0;
  const attributionEvents = [];
  const full = opts.full || config.pendingBackfill;
  for (const scanner of SCANNERS) {
    if (!surfaceEnabled(config, scanner.surface))
      continue;
    const mark = full ? void 0 : sinceForSurface(state, scanner.surface);
    if (mark)
      anyWatermark = true;
    const since = mark ? new Date(mark.getTime() - WATERMARK_OVERLAP_MS) : void 0;
    const scanStartedAt = /* @__PURE__ */ new Date();
    const scanned = await scanner.scan({ since });
    const candidates = scanned.filter(
      (e) => e.externalId.length > 0 && e.occurredAt >= minOccurredAt && e.occurredAt <= maxOccurredAt
    );
    await placer.place(scanned);
    const events = candidates.filter((e) => eventInScope(e, config));
    heldByScope += candidates.length - events.length;
    if (events.length === 0) {
      await stampSurface(state, scanner.surface, scanStartedAt);
      continue;
    }
    anyEvents = true;
    if (scanner.surface === "claude-code" || scanner.surface === "codex") {
      for (const e of events)
        attributionEvents.push(e);
    }
    const account = scanner.readAccount ? await scanner.readAccount() : null;
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);
      const body = {
        source: { surface: scanner.surface, kind: "local_logs" },
        account,
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
      if (res.status === 401) {
        throw new Error("Token revoked or expired \u2014 run `centrail connect`");
      }
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        throw new Error(
          `Sync failed for ${scanner.surface} (${res.status})${b?.error ? `: ${b.error}` : ""}`
        );
      }
      const result = await res.json();
      grandInserted += result.inserted;
      grandSkipped += result.skipped;
      grandInbox += result.inboxCount;
    }
    await stampSurface(state, scanner.surface, scanStartedAt);
  }
  if (config.pendingBackfill) {
    config.pendingBackfill = false;
    await writeConfig(config);
  }
  if (!anyEvents) {
    if (heldByScope > 0) {
      console.log(`Nothing in scope to sync \u2014 ${heldByScope} event(s) held back by your scope (see \`centrail repos\`).`);
    } else {
      console.log(
        anyWatermark ? "No new events since the last sync." : "No agent usage found (Claude Code, Copilot CLI, Codex)."
      );
    }
    return;
  }
  if (attributionEvents.length > 0) {
    await pushAttributions(auth, attributionEvents, resolver, config, caps, installId);
  }
  console.log(
    `Inserted ${grandInserted} \xB7 Skipped ${grandSkipped}` + (grandInbox > 0 ? ` \xB7 ${grandInbox} to review in Inbox` : "") + (heldByScope > 0 ? ` \xB7 ${heldByScope} held back by scope` : "")
  );
}
async function learnConfigDirs() {
  const known = claudeConfigDirs();
  const learned = [];
  for (const line of (await readSidecar()).values()) {
    if (line.surface !== "claude-code" || !line.transcript)
      continue;
    const i = line.transcript.lastIndexOf("/projects/");
    if (i <= 0)
      continue;
    const dir = line.transcript.slice(0, i);
    if (!known.includes(dir) && !learned.includes(dir))
      learned.push(dir);
  }
  if (learned.length > 0)
    process.env.CLAUDE_CONFIG_DIR = [...known, ...learned].join(",");
}
async function stampSurface(state, surface, scanStartedAt) {
  state.surfaces[surface] = scanStartedAt.toISOString();
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
    bucket(root, "HEAD", repo.label, repo.key).events.push(e);
  }
  const rootByKey = /* @__PURE__ */ new Map();
  for (const b of buckets.values())
    if (!rootByKey.has(b.key))
      rootByKey.set(b.key, b.root);
  for (const e of orphans) {
    const repo = e.metadata.repo;
    let root = rootByKey.get(repo.key);
    if (!root) {
      const found = await resolver.liveRootForKey(repo.key);
      if (!found)
        continue;
      rootByKey.set(repo.key, root = found);
    }
    const branch = resolver.sidecarBranchFor(e);
    bucket(root, branch ? `refs/heads/${branch}` : "--all", repo.label, repo.key).events.push(e);
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
        branch: branchByExternalId.get(m.externalId) ?? null,
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
  const tally = await runFatePass(auth, [...fateRepos.values()], serverMatches ? repos : [], installId);
  if (tally) {
    console.log(`  \u21B3 ${formatShipStatusLine(tally)}`);
  }
}

// src/index.ts
var [, , command, ...rest] = process.argv;
var flags = { url: void 0, full: false, last: false };
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--url")
    flags.url = rest[++i];
  else if (rest[i] === "--full")
    flags.full = true;
  else if (rest[i] === "--last")
    flags.last = true;
}
var USAGE = `centrail \u2014 sync local AI agent usage to centrail.org

Usage:
  centrail connect [--url <base>]   Pair this machine with your account
  centrail sync [--full]            Push new usage events (--full rescans everything)
  centrail install-hooks            Auto-sync: add the Stop hook to Claude Code (and Codex, if present)
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
  if (command === "connect") {
    await runConnect({ baseUrl: flags.url });
  } else if (command === "sync") {
    await runSync({ full: flags.full });
  } else if (command === "install-hooks") {
    await runInstallHooks({ remove: false });
  } else if (command === "uninstall-hooks") {
    await runInstallHooks({ remove: true });
  } else if (command === "inspect") {
    const last = await readLastSync();
    console.log(last ?? "No sync has run on this machine yet.");
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
  console.error(`\u2717 ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
