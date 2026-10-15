import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR, replaceFile } from "./config.js";
import type { GatheredFacts } from "./ship-status.js";

// The fate pass's git facts, remembered per repository between syncs.
// Gathering them is most of a sync's time on a machine with many live
// checkouts (seconds per repository, every sync, measured at 232 s for 52
// worktrees of 19 repositories), and they change only when a ref moves.
// An entry answers only for the same repository, default branch, patch-id
// setting, refs digest (git.ts readRefsDigest) and UTC day: the 90-day
// window and the age rules move with the calendar, so a day-old entry is
// recomputed. Local only, mode 0600: it holds commit shas and author emails
// git already holds on this machine, and nothing in it is sent as-is.

const MEMO_PATH = join(CONFIG_DIR, "fate-facts.json");
const VERSION = 1;
// Entries for repositories no sync has touched in this long are dropped.
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

type Entry = { digest: string; day: string; usedAt: string; facts: GatheredFacts };

export type FactsMemo = {
  get(key: string, digest: string, now: Date): GatheredFacts | undefined;
  set(key: string, digest: string, now: Date, facts: GatheredFacts): void;
  save(): Promise<void>;
};

export function memoKey(commonDir: string, defaultBranch: string, withPatchIds: boolean): string {
  return `${commonDir}\u0000${defaultBranch}\u0000${withPatchIds ? "patch-id" : ""}`;
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export async function loadFactsMemo(path: string = MEMO_PATH): Promise<FactsMemo> {
  let entries: Record<string, Entry> = {};
  try {
    const raw = JSON.parse(await readFile(path, "utf-8")) as { version?: unknown; entries?: unknown };
    if (raw.version === VERSION && raw.entries && typeof raw.entries === "object") entries = raw.entries as Record<string, Entry>;
  } catch {
    // absent or unreadable: every repository is gathered fresh
  }
  let dirty = false;
  return {
    get(key, digest, now) {
      const e = entries[key];
      if (!e || e.digest !== digest || e.day !== utcDay(now) || !e.facts || !Array.isArray(e.facts.shas)) return undefined;
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
        await mkdir(join(path, ".."), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify({ version: VERSION, entries }), { mode: 0o600 });
        await replaceFile(tmp, path);
        dirty = false;
      } catch {
        // a memo that cannot be written costs the next sync time, never data
      }
    },
  };
}
