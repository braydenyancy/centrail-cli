import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.js";
import { copyLabel, detectChannel, type UpdateChannel } from "./update.js";
import { CLI_VERSION } from "./version.js";

// One sync at a time per machine, so two syncs never race the watermark file
// or push the same events twice. `mkdir` is the lock: it is atomic on every
// platform (an existing dir fails with EEXIST), which `existsSync` +
// `writeFile` is not. Inside it, owner.json says who holds it.

const LOCK_PATH = join(CONFIG_DIR, "sync.lock");
const OWNER_FILE = "owner.json";

// Ownerless lock directories (0.5.0-era clients, or a holder that died
// between its mkdir and its owner write), unreadable owner files, and holders
// on another host whose pid cannot be checked here: reclaimed when nothing
// has touched the lock for this long.
export const LOCK_STALE_MS = 15 * 60 * 1000;
// A holder touches owner.json this often, so its mtime is its last sign of
// life whatever the wall clock of its start.
export const LOCK_HEARTBEAT_MS = 30 * 1000;
// A same-host holder whose pid is alive but which has not touched its owner
// file for this long is not this sync: the pid was reused, or the process is
// wedged. Generous because a laptop asleep mid-sync looks the same until it
// wakes, and taking over then only repeats idempotent sends.
export const LOCK_ABANDONED_MS = 60 * 60 * 1000;
// The reclaim guard is held for a few file operations; one older than this
// was left by a process that died holding it.
const GUARD_STALE_MS = 60 * 1000;

export type LockPurpose = "sync" | "compact";
// Who started the holder: a Stop hook's detached sync, or a person or agent.
export type LockOrigin = "hook" | "command";

// owner.json. `pid` and `nonce` are all a 0.6–0.9 client reads; the rest is
// optional so either side reads the other's file.
export type LockOwner = {
  pid: number;
  nonce: string;
  host?: string;
  startedAt?: string;
  copy?: UpdateChannel;
  version?: string;
  purpose?: LockPurpose;
  origin?: LockOrigin;
};

// What a refused or reclaiming claim learned about the lock it met.
export type LockHolder = {
  owner: LockOwner | null; // null: no readable owner file
  touchedAt: Date; // the owner file's mtime (its heartbeat), else the directory's
  foreignHost: boolean;
};

export type SyncLock = { release: () => Promise<void>; reclaimed?: LockHolder };
export type LockClaim = SyncLock | { held: LockHolder | null };

export type ClaimOptions = {
  purpose?: LockPurpose;
  now?: () => number;
  host?: string;
  isAlive?: (pid: number) => boolean;
  heartbeatMs?: number;
};

export function syncOrigin(env: Record<string, string | undefined> = process.env): LockOrigin {
  return env.CENTRAIL_SYNC_ORIGIN === "hook" ? "hook" : "command";
}

export async function claimSyncLock(lockPath: string = LOCK_PATH, opts: ClaimOptions = {}): Promise<LockClaim> {
  const now = opts.now ?? Date.now;
  const host = opts.host ?? hostname();
  const isAlive = opts.isAlive ?? processIsAlive;
  await mkdir(join(lockPath, ".."), { recursive: true });
  let reclaimed: LockHolder | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = await readHolder(lockPath, host);
      if (!holder) continue; // released between our mkdir and the read — try again
      if (!abandoned(holder, now(), isAlive)) return { held: holder };
      if (!(await reclaim(lockPath, holder, host, now))) {
        // Another process is reclaiming it, or took it fresh: theirs.
        const current = await readHolder(lockPath, host);
        if (current) return { held: current };
        continue;
      }
      reclaimed = holder;
      continue;
    }
    const owner: LockOwner = {
      pid: process.pid,
      nonce: randomUUID(),
      host,
      startedAt: new Date(now()).toISOString(),
      copy: detectChannel(),
      version: CLI_VERSION,
      purpose: opts.purpose ?? "sync",
      origin: syncOrigin(),
    };
    const ownerPath = join(lockPath, OWNER_FILE);
    try {
      await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 });
    } catch (err) {
      await rm(lockPath, { recursive: true, force: true });
      throw err;
    }
    const beat = setInterval(() => {
      const t = new Date();
      void utimes(ownerPath, t, t).catch(() => {});
    }, opts.heartbeatMs ?? LOCK_HEARTBEAT_MS);
    beat.unref(); // never what keeps the process alive
    return {
      ...(reclaimed ? { reclaimed } : {}),
      release: async () => {
        clearInterval(beat);
        const current = await readOwner(lockPath);
        if (current?.nonce === owner.nonce) await rm(lockPath, { recursive: true, force: true });
      },
    };
  }
  return { held: await readHolder(lockPath, host) };
}

// The pre-0.10 shape: the release function, or null when another holds it.
export async function acquireSyncLock(lockPath: string = LOCK_PATH, opts: ClaimOptions = {}): Promise<(() => Promise<void>) | null> {
  const claim = await claimSyncLock(lockPath, opts);
  return "release" in claim ? claim.release : null;
}

// A holder that cannot still be syncing. A live pid on this host always wins
// unless it has stopped beating for an hour (pid reuse, a wedged process);
// owners from before the heartbeat (no `startedAt`) are trusted while alive.
export function abandoned(holder: LockHolder, now: number, isAlive: (pid: number) => boolean = processIsAlive): boolean {
  const silentMs = now - holder.touchedAt.getTime();
  const { owner } = holder;
  if (!owner || holder.foreignHost) return silentMs >= LOCK_STALE_MS;
  if (!isAlive(owner.pid)) return true;
  return owner.startedAt !== undefined && silentMs >= LOCK_ABANDONED_MS;
}

// Remove a lock judged abandoned, atomically with respect to other
// reclaimers: a second directory guards the check-and-remove, and the lock
// is removed only if it is still the one judged (same nonce, or still
// ownerless), so a fresh holder that took it meanwhile is never deleted.
// The lock is renamed aside before it is removed: a crash mid-delete leaves
// no half-removed lock behind.
const RENAME_BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_RETRIES = 20;
const RENAME_RETRY_MS = 50;

async function reclaim(lockPath: string, judged: LockHolder, host: string, now: () => number): Promise<boolean> {
  const guard = `${lockPath}.reclaim`;
  try {
    await mkdir(guard);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const age = await stat(guard).then((s) => now() - s.mtimeMs, () => 0);
    if (age < GUARD_STALE_MS) return false;
    await rm(guard, { recursive: true, force: true });
    try {
      await mkdir(guard);
    } catch {
      return false;
    }
  }
  try {
    const current = await readHolder(lockPath, host);
    if (!current) return true; // already gone: the caller retries its mkdir
    const same = judged.owner ? current.owner?.nonce === judged.owner.nonce : !current.owner;
    if (!same) return false;
    const aside = `${lockPath}.stale-${randomUUID()}`;
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(lockPath, aside);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return true;
        // Windows refuses to rename a directory while another process has a
        // file in it open (a claimer reading owner.json): retry briefly, as
        // npm's graceful-fs does, then leave the lock to whoever holds it.
        if (!RENAME_BUSY.has(code ?? "")) throw err;
        if (attempt >= RENAME_RETRIES) return false;
        await new Promise((r) => setTimeout(r, RENAME_RETRY_MS));
      }
    }
    await rm(aside, { recursive: true, force: true });
    return true;
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
}

async function readHolder(lockPath: string, host: string): Promise<LockHolder | null> {
  const owner = await readOwner(lockPath);
  let touched: number;
  try {
    const dir = (await stat(lockPath)).mtimeMs;
    const file = await stat(join(lockPath, OWNER_FILE)).then((s) => s.mtimeMs, () => 0);
    touched = Math.max(dir, file);
  } catch {
    return null;
  }
  return {
    owner,
    touchedAt: new Date(touched),
    foreignHost: owner?.host !== undefined && owner.host !== host,
  };
}

async function readOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const raw = JSON.parse(await readFile(join(lockPath, OWNER_FILE), "utf-8")) as Record<string, unknown>;
    if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0 || typeof raw.nonce !== "string" || raw.nonce.length === 0) {
      return null;
    }
    const str = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length < 256 ? v : undefined);
    const startedAt = str(raw.startedAt);
    const copy = str(raw.copy);
    return {
      pid: raw.pid,
      nonce: raw.nonce,
      ...(str(raw.host) ? { host: str(raw.host) } : {}),
      ...(startedAt && !Number.isNaN(new Date(startedAt).getTime()) ? { startedAt } : {}),
      ...(copy && ["plugin", "npx", "mise", "npm-global", "unknown"].includes(copy) ? { copy: copy as UpdateChannel } : {}),
      ...(str(raw.version) ? { version: str(raw.version) } : {}),
      ...(raw.purpose === "sync" || raw.purpose === "compact" ? { purpose: raw.purpose } : {}),
      ...(raw.origin === "hook" || raw.origin === "command" ? { origin: raw.origin } : {}),
    };
  } catch {
    return null;
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// "the Claude Code plugin's background sync (centrail 0.9.0, pid 4242,
// started 14:02, 3 min ago)" — enough to find it in a process list.
export function describeHolder(holder: LockHolder, now: number = Date.now()): string {
  const { owner } = holder;
  if (!owner) return `a sync whose lock names no owner (last touched ${ago(now - holder.touchedAt.getTime())})`;
  const what =
    owner.purpose === "compact" ? "hook tidying its session log" : owner.origin === "hook" ? "background sync" : "sync";
  const label = `${whose(owner.copy)} ${what}`;
  const details = [
    owner.version ? `centrail ${owner.version}` : undefined,
    `pid ${owner.pid}`,
    holder.foreignHost && owner.host ? `on ${owner.host}` : undefined,
    owner.startedAt ? `started ${clock(new Date(owner.startedAt))}, ${ago(now - new Date(owner.startedAt).getTime())}` : undefined,
  ].filter(Boolean);
  return `${label} (${details.join(", ")})`;
}

export function heldMessage(holder: LockHolder | null, now: number = Date.now()): string {
  if (!holder) return "Another sync is already running on this computer. Try again when it finishes.";
  const where = holder.foreignHost ? "on another computer sharing this config" : "on this computer";
  return `Another sync is already running ${where}: ${describeHolder(holder, now)}. Try again when it finishes.`;
}

export function reclaimedMessage(holder: LockHolder, now: number = Date.now()): string {
  const why = holder.owner && !holder.foreignHost ? "it is no longer running" : "it stopped updating its lock";
  return `Took over the sync lock left by ${describeHolder(holder, now)}: ${why}.`;
}

// Which copy, from the channel its script path showed (update.ts).
function whose(copy: UpdateChannel | undefined): string {
  switch (copy) {
    case undefined: return "an older centrail's"; // owner files before 0.10 name no copy
    case "unknown": return "another install's";
    case "npx": return "an npx run's";
    default: return `the ${copyLabel(copy)}'s`;
  }
}

function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min ago` : `${h} h ago`;
}
