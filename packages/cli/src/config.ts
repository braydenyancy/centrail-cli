import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSyncState, type SyncState } from "./watermarks.js";

export type { SyncState } from "./watermarks.js";

// Overridable so tests and probes can run the real binary against a scratch
// dir; never documented as a user knob.
export const CONFIG_DIR =
  process.env.CENTRAIL_CONFIG_DIR?.trim() || join(homedir(), ".config", "centrail");
const AUTH_PATH = join(CONFIG_DIR, "auth.json");
const STATE_PATH = join(CONFIG_DIR, "state.json");

export type AuthConfig = {
  baseUrl: string;
  token: string;
  deviceName: string;
};

export async function readAuth(): Promise<AuthConfig | null> {
  try {
    const raw = JSON.parse(await readFile(AUTH_PATH, "utf-8")) as Record<
      string,
      unknown
    >;
    if (
      typeof raw.baseUrl !== "string" ||
      typeof raw.token !== "string" ||
      typeof raw.deviceName !== "string"
    ) {
      return null;
    }
    return {
      baseUrl: raw.baseUrl,
      token: raw.token,
      deviceName: raw.deviceName,
    };
  } catch {
    return null;
  }
}

// Every config file is written through a temp file + rename, so a reader
// racing the writer sees the old file or the new one, never a torn one.
// rename is atomic within one filesystem on every platform we support.
async function writeJsonAtomic(path: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? {} : { mode });
  await rename(tmp, path);
}

export async function writeAuth(auth: AuthConfig): Promise<void> {
  await writeJsonAtomic(AUTH_PATH, auth, 0o600);
  await chmod(AUTH_PATH, 0o600); // contains the bearer token
}

export async function readState(): Promise<SyncState> {
  try {
    return parseSyncState(JSON.parse(await readFile(STATE_PATH, "utf-8")));
  } catch {
    return parseSyncState(null);
  }
}

export async function writeState(state: SyncState): Promise<void> {
  await writeJsonAtomic(STATE_PATH, state);
}

const LOCK_PATH = join(CONFIG_DIR, "sync.lock");
// Compatibility window for ownerless lock directories written by 0.5.0-era
// clients. New locks carry a PID and are never reclaimed while it is alive.
export const LOCK_STALE_MS = 15 * 60 * 1000;
const LOCK_OWNER_FILE = "owner.json";

type LockOwner = {
  pid: number;
  nonce: string;
};

// One sync at a time per machine, so two syncs never race the watermark file
// or push the same events twice. `mkdir` is the lock: it is atomic on every
// platform (an existing dir fails with EEXIST), which `existsSync` + `writeFile`
// is not. Returns the release function, or null when another sync holds it.
export async function acquireSyncLock(lockPath: string = LOCK_PATH): Promise<(() => Promise<void>) | null> {
  await mkdir(join(lockPath, ".."), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lockPath);
      const owner: LockOwner = { pid: process.pid, nonce: randomUUID() };
      try {
        await writeFile(join(lockPath, LOCK_OWNER_FILE), JSON.stringify(owner), {
          mode: 0o600,
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
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      // A live owning process wins regardless of elapsed time. Full backfills
      // can legitimately take longer than the legacy 15-minute stale window.
      const owner = await readLockOwner(lockPath);
      if (owner && processIsAlive(owner.pid)) return null;

      let ageMs: number;
      try {
        ageMs = Date.now() - (await stat(lockPath)).mtimeMs;
      } catch {
        continue; // released between our mkdir and stat — try once more
      }
      // New locks from older clients have no owner file. Give them the legacy
      // stale window; owned locks can be reclaimed as soon as their PID dies.
      if (!owner && ageMs < LOCK_STALE_MS) return null;
      await rm(lockPath, { recursive: true, force: true }); // stale: reclaim
    }
  }
  return null;
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const raw = JSON.parse(
      await readFile(join(lockPath, LOCK_OWNER_FILE), "utf-8"),
    ) as Record<string, unknown>;
    if (
      typeof raw.pid !== "number" ||
      !Number.isInteger(raw.pid) ||
      raw.pid <= 0 ||
      typeof raw.nonce !== "string" ||
      raw.nonce.length === 0
    ) {
      return null;
    }
    return { pid: raw.pid, nonce: raw.nonce };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export type Config = {
  denyRepos: string[]; // repo keys ("github.com/o/r") or labels to never attribute
  installId: string | null; // random per-install id; null until first ensureInstallId
  hideRepoNames: boolean; // ship repo identity as a keyed hash, no label
  hideBranchNames: boolean; // never ship gitBranch
};

const DEFAULT_CONFIG: Config = {
  denyRepos: [],
  installId: null,
  hideRepoNames: false,
  hideBranchNames: false,
};

export async function readConfig(): Promise<Config> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, "utf-8")) as Record<
      string,
      unknown
    >;
    return {
      denyRepos: Array.isArray(raw.denyRepos)
        ? raw.denyRepos.filter((r): r is string => typeof r === "string")
        : [],
      installId: typeof raw.installId === "string" && raw.installId ? raw.installId : null,
      hideRepoNames: raw.hideRepoNames === true,
      hideBranchNames: raw.hideBranchNames === true,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeConfig(cfg: Config): Promise<void> {
  await writeJsonAtomic(CONFIG_PATH, cfg);
}

export async function addDenyRepo(name: string): Promise<void> {
  const cfg = await readConfig();
  if (!cfg.denyRepos.includes(name)) cfg.denyRepos.push(name);
  await writeConfig(cfg);
}

// The install id replaces the hostname on the wire: a random uuid minted
// once per machine, meaningless off it, and the HMAC key for folder ids.
// Created lazily so a config written by an older CLI upgrades in place.
export async function ensureInstallId(): Promise<string> {
  const cfg = await readConfig();
  if (cfg.installId) return cfg.installId;
  cfg.installId = randomUUID();
  await writeConfig(cfg);
  return cfg.installId;
}

// The last ingest body exactly as sent, for `centrail inspect --last`. One
// file, overwritten per batch, mode 0600: it is the answer to "what leaves
// my machine", and it must be the real payload, not a description of it.
const LAST_SYNC_PATH = join(CONFIG_DIR, "last-sync.json");

export async function writeLastSync(body: unknown): Promise<void> {
  await writeJsonAtomic(LAST_SYNC_PATH, body, 0o600);
}

export async function readLastSync(): Promise<string | null> {
  try {
    return await readFile(LAST_SYNC_PATH, "utf-8");
  } catch {
    return null;
  }
}
