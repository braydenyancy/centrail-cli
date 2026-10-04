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

function memState(initial: SyncState = { lastSyncAt: null, surfaces: {}, scannerRevisions: {} }) {
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
    expect(shouldAutoSync({}, now)).toBe(true);
    expect(shouldAutoSync({ autoSyncAt: "garbage" }, now)).toBe(true);
    expect(shouldAutoSync({ autoSyncAt: "2026-06-01T09:55:00Z" }, now)).toBe(false);
    expect(shouldAutoSync({ autoSyncAt: "2026-06-01T09:50:00Z" }, now)).toBe(true);
  });

  it.each([
    ["no stamp", undefined, true],
    ["9 min ago", -9 * 60 * 1000, false],
    ["exactly the interval ago", -AUTO_SYNC_INTERVAL_MS, true],
    ["an hour ago", -60 * 60 * 1000, true],
    ["300 ms in the future (a racing hook's claim, not a clock step)", 300, false],
    ["2 min in the FUTURE (clock stepped back)", 2 * 60 * 1000, true],
    ["a day in the future", 24 * 60 * 60 * 1000, true],
    ["garbage", "not-a-date", true],
  ])("shouldAutoSync with stamp %s → %s", (_, offset, expected) => {
    const now = new Date("2026-06-01T12:00:00Z");
    const autoSyncAt =
      offset === undefined ? undefined : typeof offset === "string" ? offset : new Date(now.getTime() + offset).toISOString();
    expect(shouldAutoSync({ ...(autoSyncAt ? { autoSyncAt } : {}) }, now)).toBe(expected);
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

  it("reads the transcript from the previous line's offset, records each touched root once, and starts over if the file shrank", async () => {
    fx = await scratch();
    const { writeFile, appendFile, mkdir } = await import("node:fs/promises");
    const ws = join(fx.root, "ws");
    await mkdir(ws);
    const a = await fx.repo("ws/a", { remote: "https://github.com/acme/a.git" });
    const b = await fx.repo("ws/b", { remote: "https://github.com/acme/b.git" });
    const sidecarPath = join(fx.root, "sessions.jsonl");
    const transcript = join(fx.root, "t.jsonl");
    const tool = (name: string, input: Record<string, unknown>) =>
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name, input }] } })}\n`;
    const deps = { sidecarPath, spawnSync: () => {}, connected: async () => false, ...memState() };
    const fire = () => runStopHook(JSON.stringify({ session_id: "s", cwd: ws, transcript_path: transcript }), "claude-code", deps);

    // Turn 1: an edit in a, plus a partial trailing line that must wait.
    await writeFile(transcript, tool("Edit", { file_path: join(a, "new-dir", "x.ts") }) + '{"type":"assistant","partial');
    const l1 = (await fire())!;
    expect(Object.values(l1.roots!)).toEqual([{ key: "github.com/acme/a", label: "a", source: "remote", root: expect.stringMatching(/^[0-9a-f]{40}$/) }]);
    const firstLineBytes = Buffer.byteLength(tool("Edit", { file_path: join(a, "new-dir", "x.ts") }));
    expect(l1.offset).toBe(firstLineBytes);

    // Turn 2: the partial line completes (it was thinking), then a Bash in b; a must not be re-resolved.
    await writeFile(transcript, tool("Edit", { file_path: join(a, "new-dir", "x.ts") }) + '{"type":"assistant","partial":true}\n' + tool("Bash", { command: `cd ${b} && ls` }));
    const l2 = (await fire())!;
    expect(Object.keys(l2.roots!).sort()).toEqual([a, b].sort());
    expect(l2.offset).toBe((await (await import("node:fs/promises")).stat(transcript)).size);

    // The transcript is rewritten shorter (Claude Code compaction): offset resets, roots are kept.
    await writeFile(transcript, tool("Read", { file_path: join(b, "y.ts") }));
    const l3 = (await fire())!;
    expect(l3.offset).toBe(0); // shrank: nothing consumed until the next turn
    expect(Object.keys(l3.roots!).sort()).toEqual([a, b].sort());
    await appendFile(transcript, tool("Read", { file_path: join(a, "z.ts") }));
    const l4 = (await fire())!;
    expect(l4.offset).toBeGreaterThan(0);
    expect((await readSidecar(sidecarPath)).get("s")?.roots).toEqual(l4.roots);
  });

  it("a submodule's files record the submodule's root, though the superproject around it was recorded first", async () => {
    fx = await scratch();
    const { writeFile, mkdir } = await import("node:fs/promises");
    const ws = join(fx.root, "ws");
    await mkdir(ws);
    const a = await fx.repo("ws/a", { remote: "https://github.com/acme/a.git" });
    const lib = await fx.repo("lib-src");
    await fx.git(a, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib");
    const sub = join(a, "vendor", "lib");
    await fx.git(sub, "remote", "set-url", "origin", "https://github.com/acme/lib.git");
    const transcript = join(fx.root, "t.jsonl");
    const tool = (input: Record<string, unknown>) =>
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Edit", input }] } })}\n`;
    await writeFile(transcript, tool({ file_path: join(a, "x.ts") }) + tool({ file_path: join(sub, "y.ts") }));
    const line = (await runStopHook(JSON.stringify({ session_id: "s", cwd: ws, transcript_path: transcript }), "claude-code", {
      sidecarPath: join(fx.root, "sessions.jsonl"), spawnSync: () => {}, connected: async () => false, ...memState(),
    }))!;
    expect(line.roots?.[a]?.key).toBe("github.com/acme/a");
    expect(line.roots?.[sub]?.key).toBe("github.com/acme/lib");
  });

  it("without a transcript_path (another harness, an older Claude Code) there is no offset; the cwd root is still recorded, with its main checkout when it is a worktree", async () => {
    fx = await scratch();
    const repo = await fx.repo("r", { remote: "https://github.com/acme/r.git" });
    const wt = await fx.worktree(repo, "r-wt", "wt");
    const sidecarPath = join(fx.root, "sc.jsonl");
    const deps = { sidecarPath, spawnSync: () => {}, connected: async () => false, ...memState() };
    const inMain = (await runStopHook(JSON.stringify({ session_id: "s1", cwd: repo }), "claude-code", deps))!;
    expect(inMain.offset).toBeUndefined();
    expect(inMain.roots).toEqual({ [repo]: { key: "github.com/acme/r", label: "r", source: "remote", root: expect.stringMatching(/^[0-9a-f]{40}$/) } });
    expect(inMain.mains).toBeUndefined(); // a main checkout has no main
    const inWt = (await runStopHook(JSON.stringify({ session_id: "s2", cwd: wt }), "claude-code", deps))!;
    expect(inWt.roots).toEqual({ [wt]: { key: "github.com/acme/r", label: "r-wt", source: "remote", root: expect.stringMatching(/^[0-9a-f]{40}$/) } });
    expect(inWt.mains).toEqual({ [wt]: repo });
  });

  it("a Codex Stop hook (turn_id, rollout transcript) is recorded as surface codex, with the rollout's shell workdir and patch files as roots", async () => {
    fx = await scratch();
    const { writeFile, mkdir } = await import("node:fs/promises");
    const ws = join(fx.root, "ws");
    await mkdir(ws);
    const a = await fx.repo("ws/a", { remote: "https://github.com/acme/a.git" });
    const b = await fx.repo("ws/b", { remote: "https://github.com/acme/b.git" });
    const sessionsDir = join(fx.root, "codex-home", "sessions", "2026", "09", "26");
    await mkdir(sessionsDir, { recursive: true });
    const transcript = join(sessionsDir, "rollout-2026-09-26T10-00-00-thread1.jsonl");
    const lines = [
      { type: "session_meta", payload: { id: "thread1", cwd: ws } },
      { type: "turn_context", payload: { turn_id: "t1", cwd: ws } },
      { type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "ls"], workdir: a }) } },
      { type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ input: `*** Begin Patch\n*** Update File: b/x.ts\n*** End Patch` }) } },
      { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1, output_tokens: 1 } } } },
    ];
    await writeFile(transcript, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const sidecarPath = join(fx.root, "sessions.jsonl");
    const line = (await runStopHook(
      JSON.stringify({ session_id: "thread1", cwd: ws, transcript_path: transcript, hook_event_name: "Stop", turn_id: "t1", model: "gpt-5", permission_mode: "default", stop_hook_active: false, last_assistant_message: null }),
      "claude-code", // the plugin cannot tell the harness apart; the hook must
      { sidecarPath, spawnSync: () => {}, connected: async () => false, ...memState() },
    ))!;
    expect(line.surface).toBe("codex");
    expect(line.sessionId).toBe("thread1");
    expect(Object.keys(line.roots!).sort()).toEqual([a, b].sort());
    expect(line.offset).toBeGreaterThan(0);
  });
});

