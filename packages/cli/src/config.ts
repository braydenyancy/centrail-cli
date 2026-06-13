import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".config", "centrail");
const AUTH_PATH = join(CONFIG_DIR, "auth.json");
const STATE_PATH = join(CONFIG_DIR, "state.json");

export type AuthConfig = {
  baseUrl: string;
  token: string;
  deviceName: string;
};

export type SyncState = {
  lastSyncAt: string | null; // ISO timestamp of the last fully-successful sync
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

export async function writeAuth(auth: AuthConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(AUTH_PATH, `${JSON.stringify(auth, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(AUTH_PATH, 0o600); // contains the bearer token
}

export async function readState(): Promise<SyncState> {
  try {
    const raw = JSON.parse(await readFile(STATE_PATH, "utf-8")) as Record<
      string,
      unknown
    >;
    return {
      lastSyncAt: typeof raw.lastSyncAt === "string" ? raw.lastSyncAt : null,
    };
  } catch {
    return { lastSyncAt: null };
  }
}

export async function writeState(state: SyncState): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export type Config = {
  denyRepos: string[]; // repo names (basenames) to never attribute
};

export async function readConfig(): Promise<Config> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, "utf-8")) as Record<
      string,
      unknown
    >;
    const denyRepos = Array.isArray(raw.denyRepos)
      ? raw.denyRepos.filter((r): r is string => typeof r === "string")
      : [];
    return { denyRepos };
  } catch {
    return { denyRepos: [] };
  }
}

export async function addDenyRepo(name: string): Promise<void> {
  const cfg = await readConfig();
  if (!cfg.denyRepos.includes(name)) cfg.denyRepos.push(name);
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
}
