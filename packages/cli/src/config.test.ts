import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireSyncLock, LOCK_STALE_MS } from "./config.js";

async function lockPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "centrail-lock-")), "sync.lock");
}

describe("acquireSyncLock", () => {
  it("does not reclaim an old-looking lock while its owner is alive", async () => {
    const path = await lockPath();
    const release = await acquireSyncLock(path);
    expect(release).not.toBeNull();

    const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    await utimes(path, old, old);

    expect(await acquireSyncLock(path)).toBeNull();
    await release?.();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims an ownerless legacy lock after the stale window", async () => {
    const path = await lockPath();
    await mkdir(path);
    const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    await utimes(path, old, old);

    const release = await acquireSyncLock(path);

    expect(release).not.toBeNull();
    await release?.();
  });

  it("reclaims an owned lock after its process exits", async () => {
    const path = await lockPath();
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await once(child, "exit");
    await mkdir(path);
    await writeFile(
      join(path, "owner.json"),
      JSON.stringify({ pid: child.pid, nonce: "dead-owner" }),
    );

    const release = await acquireSyncLock(path);

    expect(release).not.toBeNull();
    await release?.();
  });

  // A hook-spawned sync racing a manual one: the second gets null, and the
  // released lock can be taken again. (A lock left by a sync that died is
  // covered above: owned locks free when their PID exits, ownerless legacy
  // ones after the stale window.)
  it("one holder at a time; released lock can be re-taken", async () => {
    const lock = await lockPath();
    const first = await acquireSyncLock(lock);
    expect(first).not.toBeNull();
    expect(await acquireSyncLock(lock)).toBeNull();
    await first!();
    const again = await acquireSyncLock(lock);
    expect(again).not.toBeNull();
    await again!();
  });
});
