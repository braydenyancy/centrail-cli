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
});
