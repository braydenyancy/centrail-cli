import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { codexCallEvidence, lineEvidence, type Evidence, type RepoIdentity } from "@centrail/parsers";
import { readAuth, readState, writeState } from "../config.js";
import { nearestDirectory, readMainCheckout, resolveRepoRoot } from "../git.js";
import { readHeadState, repoIdentity } from "../identity.js";
import { appendSidecar, readSidecar, type SidecarLine } from "../sidecar.js";
import type { SyncState } from "../watermarks.js";

// `centrail hook stop` — the collection trigger. Claude Code runs it at the
// end of every turn (Stop hook) with a JSON object on stdin. It does two
// things and nothing else:
//   1. append one sidecar line: session id, folder, repo identity, branch,
//      head, time — captured NOW, while the folder still exists;
//   2. at most once per AUTO_SYNC_INTERVAL, start a detached `centrail sync`.
// It never blocks the agent (exit 0, no stdout), never throws, and finishes
// in a few git spawns. The sync it starts takes the machine-wide lock, so a
// second hook firing in parallel is harmless.
//
// Why a Stop hook and not git hooks, a watcher or a daemon: it fires on
// agent activity (a session that burns tokens and never commits still
// fires), survives crashes (the next turn fires again), and installs with
// one settings.json entry. docs/decisions/2026-09-system-audit.md § 3.2.

export const AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000;

export type HookInput = {
  session_id?: unknown;
  cwd?: unknown;
  transcript_path?: unknown;
  hook_event_name?: unknown;
  turn_id?: unknown; // Codex only ("Codex extension" in its stop.command.input schema)
};

// One plugin serves Claude Code and Codex: both run hooks.json's Stop
// command with the same input shape. Codex adds `turn_id` and keeps its
// transcripts as `rollout-*.jsonl` under a sessions dir; either mark is
// enough to read the transcript as a rollout and stamp the surface.
export function detectSurface(input: HookInput, fallback: string): string {
  if (typeof input.turn_id === "string" && input.turn_id) return "codex";
  const t = typeof input.transcript_path === "string" ? input.transcript_path : "";
  if (/\/sessions\/.*rollout-[^/]*\.jsonl$/.test(t)) return "codex";
  return fallback;
}

// Bounds on the transcript read per turn: distinct directories that cost
// a git spawn, and bytes. A turn past either is recorded with what fit.
const MAX_DIRS_PER_TURN = 64;
const MAX_BYTES_PER_TURN = 64 * 1024 * 1024;

export type HookDeps = {
  sidecarPath?: string;
  now?: () => Date;
  spawnSync?: () => void; // test seam; default starts the detached sync
  readState?: () => Promise<SyncState>;
  writeState?: (s: SyncState) => Promise<void>;
  connected?: () => Promise<boolean>;
};

export async function runStopHook(
  raw: string,
  surface = "claude-code",
  deps: HookDeps = {},
): Promise<SidecarLine | null> {
  try {
    return await stopHook(raw, surface, deps);
  } catch {
    return null; // an unwritable sidecar, a git that is missing: the turn is lost, the agent is not
  }
}

async function stopHook(raw: string, surface: string, deps: HookDeps): Promise<SidecarLine | null> {
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    return null;
  }
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const cwd = typeof input.cwd === "string" ? input.cwd : "";
  if (!sessionId || !cwd) return null;
  surface = detectSurface(input, surface);

  const now = deps.now ? deps.now() : new Date();
  const root = await resolveRepoRoot(cwd);
  const repo = root ? await repoIdentity(root) : null;
  const head = root ? await readHeadState(root) : { branch: null, head: null };
  const line: SidecarLine = {
    v: 1,
    ts: now.toISOString(),
    surface,
    sessionId,
    cwd,
    repo,
    root,
    branch: head.branch,
    head: head.head,
  };
  // § 3.9: a session outside a repo is placed by the files its turns
  // touch. Their repos must be identified NOW, while the folders exist;
  // the transcript is read from where the last turn's hook left off.
  const transcript = typeof input.transcript_path === "string" ? input.transcript_path : "";
  const previous = (await readSidecar(deps.sidecarPath)).get(sessionId);
  const roots = { ...(previous?.roots ?? {}) };
  const mains = { ...(previous?.mains ?? {}) };
  if (root && repo) await recordRoot(root, repo, roots, mains);
  if (transcript) line.offset = await recordTouchedRoots(transcript, previous?.offset ?? 0, roots, mains, cwd);
  if (Object.keys(roots).length > 0) line.roots = roots;
  if (Object.keys(mains).length > 0) line.mains = mains;
  await appendSidecar(line, deps.sidecarPath);

  await maybeAutoSync(now, deps);
  return line;
}

// Read the transcript from `offset`, resolve the repo of every directory a
// tool call touched, and add it to `roots`. Returns the new offset. A
// directory under a root already known costs nothing; every other distinct
// one costs one git spawn, capped per turn.
// A root and its identity, plus its main checkout when it is a linked
// worktree — recorded once per root per session.
async function recordRoot(root: string, id: RepoIdentity, roots: Record<string, RepoIdentity>, mains: Record<string, string>): Promise<void> {
  if (roots[root]) return;
  roots[root] = id;
  const main = await readMainCheckout(root);
  if (main) mains[root] = main;
}

async function recordTouchedRoots(transcript: string, offset: number, roots: Record<string, RepoIdentity>, mains: Record<string, string>, cwd: string): Promise<number> {
  let fh;
  try {
    fh = await open(transcript, "r");
  } catch {
    return offset;
  }
  try {
    const size = (await fh.stat()).size;
    if (size <= offset) return size < offset ? 0 : offset; // truncated or rewritten: start over next turn
    const length = Math.min(size - offset, MAX_BYTES_PER_TURN);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    const text = buf.toString("utf-8", 0, bytesRead);
    const complete = text.lastIndexOf("\n");
    if (complete < 0) return offset; // no whole line yet
    const dirs = new Set<string>();
    let turnCwd = cwd; // Codex: turn_context may move the cwd
    for (const raw of text.slice(0, complete).split("\n")) {
      if (!raw.includes('"tool_use"') && !raw.includes('"function_call"') && !raw.includes('"turn_context"')) continue;
      let line: unknown;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isObject(line)) continue;
      let ev: Evidence | null = null;
      if (line.type === "assistant" && isObject(line.message)) ev = lineEvidence(line.message); // Claude Code
      else if (line.type === "turn_context" && isObject(line.payload) && typeof line.payload.cwd === "string") turnCwd = line.payload.cwd; // Codex
      else if (line.type === "response_item" && isObject(line.payload) && line.payload.type === "function_call") ev = codexCallEvidence(line.payload.name, line.payload.arguments, turnCwd); // Codex
      if (!ev) continue;
      for (const path of [...ev.writes, ...ev.reads]) dirs.add(path); // a file or a directory; the lookup climbs
    }
    let spawned = 0;
    const seen = new Set<string>();
    for (const path of dirs) {
      if (Object.keys(roots).some((r) => path === r || path.startsWith(`${r}/`))) continue;
      const dir = await nearestDirectory(path);
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      if (spawned++ >= MAX_DIRS_PER_TURN) break;
      const r = await resolveRepoRoot(dir);
      if (!r || roots[r]) continue;
      const id = await repoIdentity(r);
      if (id) await recordRoot(r, id, roots, mains);
    }
    return offset + complete + 1;
  } finally {
    await fh.close();
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// The throttle. The stamp is written BEFORE the spawn so two hooks racing
// past the interval together start at most one sync between them (and the
// sync lock covers the rest).
// A stamp in the future is a clock that stepped back; treating it as a
// fresh stamp would silence auto-sync until the wall clock caught up.
export function shouldAutoSync(state: SyncState, now: Date): boolean {
  if (!state.autoSyncAt) return true;
  const last = new Date(state.autoSyncAt).getTime();
  return Number.isNaN(last) || last > now.getTime() || now.getTime() - last >= AUTO_SYNC_INTERVAL_MS;
}

async function maybeAutoSync(now: Date, deps: HookDeps): Promise<void> {
  const read = deps.readState ?? readState;
  const write = deps.writeState ?? writeState;
  const connected = deps.connected ?? (async () => (await readAuth()) !== null);
  const state = await read();
  if (!shouldAutoSync(state, now)) return;
  if (!(await connected())) return; // nothing to sync to; the sidecar still grew
  state.autoSyncAt = now.toISOString();
  await write(state);
  (deps.spawnSync ?? spawnDetachedSync)();
}

// The same node and the same bundle that ran the hook, so what syncs is
// what was installed — never whatever `npx` resolves at that moment.
function spawnDetachedSync(): void {
  const child = spawn(process.execPath, [process.argv[1], "sync"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}
