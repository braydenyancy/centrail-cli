import { spawn } from "node:child_process";
import { readAuth, readState, writeState } from "../config.js";
import { resolveRepoRoot } from "../git.js";
import { readHeadState, repoIdentity } from "../identity.js";
import { appendSidecar, type SidecarLine } from "../sidecar.js";
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
  hook_event_name?: unknown;
};

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
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    return null;
  }
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const cwd = typeof input.cwd === "string" ? input.cwd : "";
  if (!sessionId || !cwd) return null;

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
  await appendSidecar(line, deps.sidecarPath);

  await maybeAutoSync(now, deps);
  return line;
}

// The throttle. The stamp is written BEFORE the spawn so two hooks racing
// past the interval together start at most one sync between them (and the
// sync lock covers the rest).
export function shouldAutoSync(state: SyncState, now: Date): boolean {
  if (!state.autoSyncAt) return true;
  const last = new Date(state.autoSyncAt).getTime();
  return Number.isNaN(last) || now.getTime() - last >= AUTO_SYNC_INTERVAL_MS;
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
