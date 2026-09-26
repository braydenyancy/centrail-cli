import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUTO_SYNC_INTERVAL_MS, runStopHook, shouldAutoSync } from "./hook.js";
import { readSidecar } from "../sidecar.js";
import { scratch, type Scratch } from "../testing/git-fixture.js";
import type { SyncState } from "../watermarks.js";

let fx: Scratch;
afterEach(async () => {
  await fx?.cleanup();
});

function memState(initial: SyncState = { lastSyncAt: null, surfaces: {} }) {
  let state = initial;
  return {
    readState: async () => state,
    writeState: async (s: SyncState) => {
      state = s;
    },
    get: () => state,
  };
}

describe("runStopHook", () => {
  it("writes one sidecar line with the repo identity and starts one sync per interval", async () => {
    fx = await scratch();
    const repo = await fx.repo("repo", { remote: "git@github.com:acme/repo.git" });
    const sidecarPath = join(fx.root, "sessions.jsonl");
    const st = memState();
    let spawns = 0;
    const deps = {
      sidecarPath,
      spawnSync: () => void spawns++,
      connected: async () => true,
      ...st,
    };
    const t0 = new Date("2026-06-01T10:00:00Z");
    const input = JSON.stringify({ session_id: "s1", cwd: repo, hook_event_name: "Stop" });

    const line = await runStopHook(input, "claude-code", { ...deps, now: () => t0 });
    expect(line).toMatchObject({
      sessionId: "s1",
      cwd: repo,
      root: repo,
      branch: "main",
      repo: { key: "github.com/acme/repo", label: "repo", source: "remote" },
    });
    expect(line?.head).toMatch(/^[0-9a-f]{40}$/);
    expect(spawns).toBe(1);
    expect(st.get().autoSyncAt).toBe(t0.toISOString());

    // Next turn, five minutes later: sidecar grows, no second sync.
    await runStopHook(input, "claude-code", {
      ...deps,
      now: () => new Date(t0.getTime() + 5 * 60 * 1000),
    });
    expect(spawns).toBe(1);
    // Past the interval: syncs again.
    await runStopHook(input, "claude-code", {
      ...deps,
      now: () => new Date(t0.getTime() + AUTO_SYNC_INTERVAL_MS),
    });
    expect(spawns).toBe(2);
    expect((await readSidecar(sidecarPath)).get("s1")?.branch).toBe("main");
  });

  it("records a plain folder with repo null, and never syncs when not connected", async () => {
    fx = await scratch();
    const plain = join(fx.root, "plain");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(plain);
    const st = memState();
    let spawns = 0;
    const line = await runStopHook(
      JSON.stringify({ session_id: "s2", cwd: plain }),
      "claude-code",
      { sidecarPath: join(fx.root, "s.jsonl"), spawnSync: () => void spawns++, connected: async () => false, ...st },
    );
    expect(line).toMatchObject({ sessionId: "s2", repo: null, root: null, branch: null });
    expect(spawns).toBe(0);
    expect(st.get().autoSyncAt).toBeUndefined();
  });

  it("ignores malformed or incomplete input without throwing", async () => {
    fx = await scratch();
    const deps = { sidecarPath: join(fx.root, "s.jsonl"), spawnSync: () => {}, connected: async () => true, ...memState() };
    expect(await runStopHook("not json", "claude-code", deps)).toBeNull();
    expect(await runStopHook(JSON.stringify({ cwd: "/x" }), "claude-code", deps)).toBeNull();
    expect((await readSidecar(deps.sidecarPath)).size).toBe(0);
  });

  it("shouldAutoSync: first ever, unparsable stamp, or past the interval", () => {
    const now = new Date("2026-06-01T10:00:00Z");
    expect(shouldAutoSync({ lastSyncAt: null, surfaces: {} }, now)).toBe(true);
    expect(shouldAutoSync({ lastSyncAt: null, surfaces: {}, autoSyncAt: "garbage" }, now)).toBe(true);
    expect(shouldAutoSync({ lastSyncAt: null, surfaces: {}, autoSyncAt: "2026-06-01T09:55:00Z" }, now)).toBe(false);
    expect(shouldAutoSync({ lastSyncAt: null, surfaces: {}, autoSyncAt: "2026-06-01T09:50:00Z" }, now)).toBe(true);
  });

  it.each([
    ["no stamp", undefined, true],
    ["9 min ago", -9 * 60 * 1000, false],
    ["exactly the interval ago", -AUTO_SYNC_INTERVAL_MS, true],
    ["an hour ago", -60 * 60 * 1000, true],
    ["1 min in the FUTURE (clock stepped back)", 60 * 1000, true],
    ["a day in the future", 24 * 60 * 60 * 1000, true],
    ["garbage", "not-a-date", true],
  ])("shouldAutoSync with stamp %s → %s", (_, offset, expected) => {
    const now = new Date("2026-06-01T12:00:00Z");
    const autoSyncAt =
      offset === undefined ? undefined : typeof offset === "string" ? offset : new Date(now.getTime() + offset).toISOString();
    expect(shouldAutoSync({ lastSyncAt: null, surfaces: {}, ...(autoSyncAt ? { autoSyncAt } : {}) }, now)).toBe(expected);
  });

  it.each([
    ["cwd does not exist", async () => "/nonexistent/path/xyz"],
    ["cwd is a file, not a directory", async () => join(fx.root, "a-file.txt")],
  ])("still records the turn when %s (repo null, never throws)", async (_, cwdOf) => {
    fx = await scratch();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(fx.root, "a-file.txt"), "x");
    const cwd = await cwdOf();
    const sidecarPath = join(fx.root, "sessions.jsonl");
    const line = await runStopHook(JSON.stringify({ session_id: "s-odd", cwd }), "claude-code", { sidecarPath, spawnSync: () => {}, connected: async () => false, ...memState() });
    expect(line).toMatchObject({ sessionId: "s-odd", cwd, repo: null, root: null });
    expect((await readSidecar(sidecarPath)).get("s-odd")?.cwd).toBe(cwd);
  });

  it("never throws, even when the sidecar cannot be written", async () => {
    fx = await scratch();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(fx.root, "blocker"), "x");
    const sidecarPath = join(fx.root, "blocker", "sessions.jsonl"); // ENOTDIR on every platform, root or not
    let spawns = 0;
    const result = await runStopHook(JSON.stringify({ session_id: "s", cwd: fx.root }), "claude-code", { sidecarPath, spawnSync: () => spawns++, connected: async () => true, ...memState() });
    expect(result).toBeNull();
    expect(spawns).toBe(0); // nothing to sync that this turn recorded
  });
});
