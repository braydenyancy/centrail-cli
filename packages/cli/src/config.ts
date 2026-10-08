import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { here, type Outdated } from "./update.js";
import { parseSyncState, type SyncState } from "./watermarks.js";

export type { SyncState } from "./watermarks.js";

// Overridable so tests and probes can run the real binary against a scratch
// dir; never documented as a user knob.
export const CONFIG_DIR =
  process.env.CENTRAIL_CONFIG_DIR?.trim() || join(homedir(), ".config", "centrail");
const AUTH_PATH = join(CONFIG_DIR, "auth.json");
const DISCONNECTED_PATH = join(CONFIG_DIR, "auth.disconnected.json");
const STATE_PATH = join(CONFIG_DIR, "state.json");

export type AuthConfig = {
  baseUrl: string;
  token: string;
  deviceName: string;
  account?: { email: string }; // who approved the pairing, when the server says (display only)
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
    const account = raw.account as { email?: unknown } | undefined;
    return {
      baseUrl: raw.baseUrl,
      token: raw.token,
      deviceName: raw.deviceName,
      ...(typeof account?.email === "string" && account.email ? { account: { email: account.email } } : {}),
    };
  } catch {
    return null;
  }
}

// The Node that last ran centrail in a terminal. The plugin's hook launcher
// (plugins/centrail/scripts/hook.sh) falls back to it when Claude Code's PATH
// has none, as when Claude Code was started from the Dock or an IDE.
export const NODE_PATH_FILE = join(CONFIG_DIR, "node");

export async function recordNode(execPath: string = process.execPath, file: string = NODE_PATH_FILE): Promise<void> {
  try {
    const now = await readFile(file, "utf-8").catch(() => "");
    if (now.trim() === execPath) return;
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, `${execPath}\n`);
  } catch {
    // best effort: the hook still tries PATH and the usual install spots
  }
}

// Every config file is written through a temp file + rename, so a reader
// racing the writer sees the old file or the new one, never a torn one.
// rename is atomic within one filesystem on every platform we support.
async function writeJsonAtomic(path: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? {} : { mode });
  await replaceFile(tmp, path);
}

// rename over an existing file is atomic everywhere, but Windows refuses it
// (EPERM, EACCES, EBUSY) while another process holds the target open: a
// hook reading the sidecar, an antivirus scan. Those holds are brief, so on
// Windows it retries for about 1.5 s before giving up.
export async function replaceFile(tmp: string, path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const held = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (platform !== "win32" || !held || attempt >= 6) {
        await rm(tmp, { force: true });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 25 * 2 ** attempt));
    }
  }
}

export async function writeAuth(auth: AuthConfig): Promise<void> {
  await writeJsonAtomic(AUTH_PATH, auth, 0o600);
  await chmod(AUTH_PATH, 0o600); // contains the bearer token
  await rm(DISCONNECTED_PATH, { force: true });
}

// Why the server refused this machine's token: its pairing was replaced from
// another machine or revoked in Settings ("device_revoked"), or no longer
// exists at all, as after an account deletion ("unknown_token"). A server
// older than the codes says neither.
export type DisconnectReason = "device_revoked" | "unknown_token" | "unauthorized";

export type Disconnected = { at: string; reason: DisconnectReason; baseUrl: string };

// A 401 parks the token instead of keeping it. With no auth.json the Stop
// hook stops starting syncs that can only fail (every 10 minutes, silently,
// forever) and compacts the sidecar instead, and the next command a person
// runs says why. `connect` clears it. The token is kept beside the reason,
// so a 401 the server sent in error is undone by renaming the file back.
export async function parkAuth(reason: DisconnectReason): Promise<void> {
  const auth = await readAuth();
  if (!auth) return;
  await writeJsonAtomic(DISCONNECTED_PATH, { ...auth, disconnectedAt: new Date().toISOString(), reason }, 0o600);
  await rm(AUTH_PATH, { force: true });
}

export async function readDisconnected(): Promise<Disconnected | null> {
  try {
    const raw = JSON.parse(await readFile(DISCONNECTED_PATH, "utf-8")) as Record<string, unknown>;
    const reason = raw.reason === "device_revoked" || raw.reason === "unknown_token" ? raw.reason : "unauthorized";
    return {
      at: typeof raw.disconnectedAt === "string" ? raw.disconnectedAt : "",
      reason,
      baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
    };
  } catch {
    return null;
  }
}

export function disconnectedMessage(d: Pick<Disconnected, "at" | "reason">): string {
  const why =
    d.reason === "device_revoked"
      ? "its pairing was replaced from another machine or revoked in Settings → Devices"
      : d.reason === "unknown_token"
        ? "its pairing no longer exists, so the account may have been deleted"
        : "the server refused its token: the pairing was revoked or the account deleted";
  const noticed = d.at ? ` (noticed ${d.at.slice(0, 10)})` : "";
  return `This machine is no longer connected to Centrail: ${why}${noticed}. Run \`npx centrail connect\` to pair it again.`;
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

// The server refuses this CLI version (HTTP 426, or a capabilities minimum
// above it; CONTRACT.md § Versioning). Unlike a 401 the token is kept: an
// outdated install is not disconnected. The park names the version, so this
// version's Stop hook starts no more syncs and an updated one starts again.
export async function parkOutdated(minimum: string | undefined): Promise<Outdated> {
  const state = await readState();
  state.outdated = { ...here(), ...(minimum ? { minimum } : {}) };
  await writeState(state);
  return state.outdated;
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

// Scope (decision doc § 3.7): which repos and which surfaces leave this
// machine. `all` with exclusions is the default; `allow` syncs only the
// listed repos and holds any new one until included. Lists hold identity
// keys ("github.com/o/r", "sha:…", "dir:…") or labels; `exclude` means
// nothing about that repo leaves — events, commits, identity.
export type ScopeMode = "all" | "allow";

export type Config = {
  installId: string | null; // random per-install id; null until first ensureInstallId
  mode: ScopeMode;
  allowRepos: string[]; // used in `allow` mode
  denyRepos: string[]; // used in both modes
  surfaces: Record<string, boolean>; // scanner surface -> enabled; absent = enabled
  scopeDecidedAt: string | null; // when the preview was shown and answered
  pendingBackfill: boolean; // scope widened: next sync rescans everything once
  hideRepoNames: boolean; // ship repo identity as a keyed hash, no label
  hideBranchNames: boolean; // never ship gitBranch
  pluginAnswer: "yes" | "no" | null; // connect's Claude Code plugin question; asked once (plugin-setup.ts)
};

const DEFAULT_CONFIG: Config = {
  installId: null,
  mode: "all",
  allowRepos: [],
  denyRepos: [],
  surfaces: {},
  scopeDecidedAt: null,
  pendingBackfill: false,
  hideRepoNames: false,
  hideBranchNames: false,
  pluginAnswer: null,
};

export function parseConfig(raw: unknown): Config {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_CONFIG };
  const o = raw as Record<string, unknown>;
  const surfaces: Record<string, boolean> = {};
  if (o.surfaces && typeof o.surfaces === "object" && !Array.isArray(o.surfaces)) {
    for (const [k, v] of Object.entries(o.surfaces as Record<string, unknown>)) {
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
    hideBranchNames: o.hideBranchNames === true,
    pluginAnswer: o.pluginAnswer === "yes" || o.pluginAnswer === "no" ? o.pluginAnswer : null,
  };
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((r): r is string => typeof r === "string") : [];
}

export async function readConfig(): Promise<Config> {
  try {
    return parseConfig(JSON.parse(await readFile(CONFIG_PATH, "utf-8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeConfig(cfg: Config): Promise<void> {
  await writeJsonAtomic(CONFIG_PATH, cfg);
}

export async function updateConfig(mutate: (cfg: Config) => void): Promise<Config> {
  const cfg = await readConfig();
  mutate(cfg);
  await writeConfig(cfg);
  return cfg;
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
