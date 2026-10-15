import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireSyncLock,
  claimSyncLock,
  describeHolder,
  heldMessage,
  LOCK_ABANDONED_MS,
  LOCK_STALE_MS,
  reclaimedMessage,
  type LockClaim,
  type LockHolder,
  type SyncLock,
} from "./sync-lock.js";
import { CLI_VERSION } from "./version.js";

async function lockPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "centrail-lock-")), "sync.lock");
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await once(child, "exit");
  return child.pid!;
}

async function plant(path: string, owner: unknown, touchedMsAgo = 0): Promise<void> {
  await mkdir(path);
  const file = join(path, "owner.json");
  await writeFile(file, typeof owner === "string" ? owner : JSON.stringify(owner));
  if (touchedMsAgo > 0) {
    const at = new Date(Date.now() - touchedMsAgo);
    await utimes(file, at, at);
    await utimes(path, at, at);
  }
}

const held = (c: LockClaim): LockHolder | null => {
  if ("release" in c) throw new Error("expected the lock to be held");
  return c.held;
};
const got = (c: LockClaim): SyncLock => {
  if (!("release" in c)) throw new Error(`expected the lock, got ${heldMessage(c.held)}`);
  return c;
};

describe("claimSyncLock: a live holder", () => {
  it("is refused and named: which copy, pid, start time and age", async () => {
    const path = await lockPath();
    const first = got(await claimSyncLock(path));
    const holder = held(await claimSyncLock(path))!;

    expect(holder.owner).toMatchObject({ pid: process.pid, host: hostname(), version: CLI_VERSION, purpose: "sync", origin: "command" });
    expect(holder.foreignHost).toBe(false);
    const msg = heldMessage(holder);
    expect(msg).toMatch(/^Another sync is already running on this computer: .+ sync \(centrail \S+, pid \d+, started \d\d:\d\d, \d+ s ago\)\. Try again when it finishes\.$/);
    await first.release();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is never reclaimed while its pid is alive and it keeps beating, however old its start", async () => {
    const path = await lockPath();
    await plant(path, { pid: process.pid, nonce: "n", host: hostname(), startedAt: new Date(Date.now() - 6 * 3600_000).toISOString() });
    expect(held(await claimSyncLock(path))?.owner?.nonce).toBe("n");
  });

  it("from before the heartbeat (no startedAt) is trusted while its pid is alive", async () => {
    const path = await lockPath();
    await plant(path, { pid: process.pid, nonce: "legacy" }, LOCK_ABANDONED_MS * 3);
    const holder = held(await claimSyncLock(path))!;
    expect(describeHolder(holder)).toMatch(/^an older centrail's sync \(pid \d+\)$/);
  });

  it("whose pid is alive but silent past the abandoned bound (pid reuse, wedged) is reclaimed", async () => {
    const path = await lockPath();
    await plant(path, { pid: process.pid, nonce: "reused", host: hostname(), startedAt: new Date(Date.now() - LOCK_ABANDONED_MS * 2).toISOString() }, LOCK_ABANDONED_MS + 60_000);
    const lock = got(await claimSyncLock(path));
    expect(lock.reclaimed?.owner?.nonce).toBe("reused");
    expect(reclaimedMessage(lock.reclaimed!)).toMatch(/^Took over the sync lock left by .+: it is no longer running\.$/);
    await lock.release();
  });

  it("beats: its owner file's mtime keeps moving while held", async () => {
    const path = await lockPath();
    const lock = got(await claimSyncLock(path, { heartbeatMs: 20 }));
    const old = new Date(Date.now() - 3600_000);
    await utimes(join(path, "owner.json"), old, old);
    await new Promise((r) => setTimeout(r, 120));
    expect(Date.now() - (await stat(join(path, "owner.json"))).mtimeMs).toBeLessThan(60_000);
    await lock.release();
  });
});

describe("claimSyncLock: a dead holder", () => {
  it("is reclaimed at once, and the claim says whose lock it took", async () => {
    const path = await lockPath();
    const pid = await deadPid();
    await plant(path, { pid, nonce: "dead", host: hostname(), startedAt: new Date(Date.now() - 120_000).toISOString(), copy: "plugin", version: "0.9.0", purpose: "sync", origin: "hook" });

    const lock = got(await claimSyncLock(path));

    expect(lock.reclaimed?.owner?.pid).toBe(pid);
    expect(reclaimedMessage(lock.reclaimed!)).toMatch(
      new RegExp(`^Took over the sync lock left by the Claude Code plugin's background sync \\(centrail 0\\.9\\.0, pid ${pid}, started \\d\\d:\\d\\d, 2 min ago\\): it is no longer running\\.$`),
    );
    // Nothing is left beside the lock: no guard, no renamed-aside copy.
    expect((await readdir(dirname(path))).sort()).toEqual(["sync.lock"]);
    await lock.release();
  });

  it("of a 0.9 owner file (pid and nonce only) is reclaimed too", async () => {
    const path = await lockPath();
    await plant(path, { pid: await deadPid(), nonce: "dead-owner" });
    const lock = got(await claimSyncLock(path));
    await lock.release();
  });
});

describe("claimSyncLock: a holder it cannot check", () => {
  it("on another host is held while it beats, then reclaimed after the stale window", async () => {
    const path = await lockPath();
    // A live pid here means nothing about a process on another machine.
    await plant(path, { pid: await deadPid(), nonce: "far", host: "other-host", startedAt: new Date().toISOString() });
    const holder = held(await claimSyncLock(path))!;
    expect(holder.foreignHost).toBe(true);
    expect(heldMessage(holder)).toMatch(/^Another sync is already running on another computer sharing this config: .*on other-host/);

    const later = got(await claimSyncLock(path, { now: () => Date.now() + LOCK_STALE_MS + 1000 }));
    expect(reclaimedMessage(later.reclaimed!)).toMatch(/it stopped updating its lock\.$/);
    await later.release();
  });

  it.each([
    ["a garbled owner file", "{not json"],
    ["an owner file with no pid", JSON.stringify({ nonce: "x" })],
  ])("with %s is held inside the stale window and reclaimed after it", async (_, raw) => {
    const path = await lockPath();
    await plant(path, raw);
    const holder = held(await claimSyncLock(path))!;
    expect(holder.owner).toBeNull();
    expect(heldMessage(holder)).toMatch(/^Another sync is already running on this computer: a sync whose lock names no owner \(last touched \d+ s ago\)\. Try again when it finishes\.$/);
    const lock = got(await claimSyncLock(path, { now: () => Date.now() + LOCK_STALE_MS + 1000 }));
    await lock.release();
  });

  it("an ownerless legacy directory is reclaimed only after the stale window", async () => {
    const path = await lockPath();
    await mkdir(path);
    expect(held(await claimSyncLock(path))).not.toBeUndefined();
    const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    await utimes(path, old, old);
    const lock = got(await claimSyncLock(path));
    await lock.release();
  });
});

describe("claimSyncLock: races", () => {
  it("many claims at once on a free lock: exactly one wins", async () => {
    const path = await lockPath();
    const claims = await Promise.all(Array.from({ length: 24 }, () => claimSyncLock(path)));
    const winners = claims.filter((c): c is SyncLock => "release" in c);
    expect(winners).toHaveLength(1);
    await winners[0].release();
  });

  it("many claims at once on a dead holder's lock: exactly one takes it over, and nobody deletes the winner's", async () => {
    const path = await lockPath();
    await plant(path, { pid: await deadPid(), nonce: "dead", host: hostname(), startedAt: new Date().toISOString() });
    const claims = await Promise.all(Array.from({ length: 24 }, () => claimSyncLock(path)));
    const winners = claims.filter((c): c is SyncLock => "release" in c);
    expect(winners).toHaveLength(1);
    // The lock on disk is the winner's: a later claim is refused by it.
    const after = held(await claimSyncLock(path))!;
    expect(after.owner?.pid).toBe(process.pid);
    expect(after.owner?.nonce).not.toBe("dead");
    await winners[0].release();
    expect((await readdir(dirname(path))).sort()).toEqual([]);
  });

  it("a release never removes a lock someone else now holds", async () => {
    const path = await lockPath();
    const first = got(await claimSyncLock(path));
    await writeFile(join(path, "owner.json"), JSON.stringify({ pid: process.pid, nonce: "someone-else", startedAt: new Date().toISOString() }));
    await first.release();
    expect(held(await claimSyncLock(path))?.owner?.nonce).toBe("someone-else");
  });

  it("acquireSyncLock keeps its release-or-null shape", async () => {
    const path = await lockPath();
    const release = await acquireSyncLock(path, { purpose: "compact" });
    expect(release).not.toBeNull();
    const holder = held(await claimSyncLock(path))!;
    expect(describeHolder(holder)).toMatch(/hook tidying its session log/);
    expect(await acquireSyncLock(path)).toBeNull();
    await release!();
  });
});
