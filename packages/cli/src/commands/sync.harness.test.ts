// The invariant every other test assumes: whatever the trigger order — hook,
// manual sync, --full, a failed batch, exclude then include, a worktree that
// dies — the server ends with exactly the transcript's final truth, once.
// Real bundle code (runSync, runStopHook), real git, real files, and an
// in-process stand-in server that models the real one: one row per
// (externalId), per-field max on re-send, `inserted` from what landed.
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scratch, type Scratch } from "../testing/git-fixture.js";
import { StandIn, transcriptLine, writeTranscript as writeTranscriptIn } from "../testing/stand-in-server.js";

// Every module that reads CENTRAIL_CONFIG_DIR / CLAUDE_CONFIG_DIR at load or
// at call time must be imported AFTER the env is set, hence dynamic imports.
const home = await mkdtemp(join(tmpdir(), "centrail-harness-"));
process.env.CENTRAIL_CONFIG_DIR = join(home, "cfg");
process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
process.env.CODEX_HOME = join(home, "codex");
const { runSync } = await import("./sync.js");
const { runStopHook } = await import("./hook.js");
const { runExclude, runInclude } = await import("./scope.js");
const { writeAuth, writeConfig, parseConfig, readConfig, readState } = await import("../config.js");

// Near the wall clock: incremental syncs only look 24 h behind their watermark.
const T0 = Date.now() - 60 * 60 * 1000;
const line = (sessionId: string, cwd: string, requestId: string, out: number, atMs = T0) =>
  transcriptLine({ sessionId, cwd, requestId, out, atMs });
const writeTranscript = (cwd: string, sessionId: string, lines: string[]) =>
  writeTranscriptIn(join(home, "claude"), cwd, sessionId, lines);

let fx: Scratch;
const server = new StandIn();
let repo: string;

beforeAll(async () => {
  await server.start();
  fx = await scratch();
  repo = await fx.repo("repo", { remote: "https://github.com/acme/repo.git" });
  await writeAuth({ baseUrl: server.url, token: "t", deviceName: "harness" });
  // Copilot's scanner reads the real home dir; keep the harness hermetic.
  await writeConfig(parseConfig({ surfaces: { "copilot-cli": false }, scopeDecidedAt: "2026-06-01T00:00:00Z" }));
});
afterAll(async () => {
  server.close();
  await fx.cleanup();
  await rm(home, { recursive: true, force: true });
});

const out = (id: string) => server.out(id);

describe("sync invariants across triggers", () => {
  it("hook mid-stream, then manual, then --full: one row per request at its final count", async () => {
    // Turn 1 ends: the transcript holds request A with output streamed so far.
    await writeTranscript(repo, "s1", [line("s1", repo, "req_A", 5)]);
    let hookSync: Promise<void> | null = null;
    await runStopHook(JSON.stringify({ session_id: "s1", cwd: repo }), "claude-code", {
      spawnSync: () => void (hookSync = runSync({ full: false })),
      connected: async () => true,
    });
    await hookSync!;
    expect(out("req_A")).toBe(5);
    expect(server.rows.get("req_A")?.metadata.repo).toMatchObject({ key: "github.com/acme/repo" });

    // Claude finishes A (final line, larger output) and starts B; the user runs sync by hand.
    await writeTranscript(repo, "s1", [line("s1", repo, "req_A", 5), line("s1", repo, "req_A", 140), line("s1", repo, "req_B", 7, T0 + 60_000)]);
    await runSync({ full: false });
    expect(out("req_A")).toBe(140); // corrected by the overlap re-send + growth upsert
    expect(out("req_B")).toBe(7);

    // A full rescan changes nothing.
    const before = new Map([...server.rows].map(([k, v]) => [k, v.outputTokens]));
    await runSync({ full: true });
    expect(new Map([...server.rows].map(([k, v]) => [k, v.outputTokens]))).toEqual(before);
    expect(server.rows.size).toBe(2);
  });

  it("a line backdated behind the watermark still arrives (24 h overlap)", async () => {
    const state = await readState();
    const mark = new Date(state.surfaces["claude-code"]).getTime();
    // Written after the last sync, stamped 2 h before it (clock skew / long turn).
    await writeTranscript(repo, "s2", [line("s2", repo, "req_C", 3, mark - 2 * 60 * 60 * 1000)]);
    await runSync({ full: false });
    expect(out("req_C")).toBe(3);
  });

  it("a failed batch leaves the watermark alone; the next sync resends and lands it", async () => {
    await writeTranscript(repo, "s3", [line("s3", repo, "req_D", 11, T0 + 120_000)]);
    const markBefore = (await readState()).surfaces["claude-code"];
    server.failNextIngests = 1;
    await expect(runSync({ full: false })).rejects.toThrow(/Sync failed/);
    expect(out("req_D")).toBeUndefined();
    expect((await readState()).surfaces["claude-code"]).toBe(markBefore);
    await runSync({ full: false });
    expect(out("req_D")).toBe(11);
  });

  it("exclude holds a repo's events; include brings its history in without --full", async () => {
    const other = await fx.repo("other", { remote: "https://github.com/acme/other.git" });
    await runExclude("github.com/acme/other");
    await writeTranscript(other, "s4", [line("s4", other, "req_E", 9, T0 + 180_000)]);
    await runSync({ full: false });
    expect(out("req_E")).toBeUndefined();
    // The watermark moved past req_E while it was held back…
    await runInclude("github.com/acme/other");
    await runSync({ full: false });
    // …and include's one-time backfill brings it in anyway.
    expect(out("req_E")).toBe(9);
    expect(server.rows.get("req_E")?.metadata.repo).toMatchObject({ key: "github.com/acme/other" });
  });

  it("a worktree deleted after its hook line still ships identity and attributes via the sibling", async () => {
    const wt = await fx.worktree(repo, "repo-wt", "wt");
    const sha = await fx.commit(wt, "b.txt", undefined, new Date()); // after the event below
    await runStopHook(JSON.stringify({ session_id: "s5", cwd: wt }), "claude-code", {
      spawnSync: () => {},
      connected: async () => false,
    });
    await fx.git(repo, "worktree", "remove", "--force", wt);
    // The event precedes the commit it produced.
    await writeTranscript(wt, "s5", [line("s5", wt, "req_F", 4, T0)]);
    await runSync({ full: false });
    expect(server.rows.get("req_F")?.metadata.repo).toMatchObject({ key: "github.com/acme/repo", label: "repo-wt" });
    expect(server.rows.get("req_F")?.metadata.cwd).toBeUndefined();
    expect(server.attributions.find((a) => a.externalId === "req_F")).toMatchObject({ repoKey: "github.com/acme/repo", commitSha: sha });
  });

  it("a checkout moved after syncing keeps its identity; earlier sessions attribute through the new path", async () => {
    const before = await fx.repo("moved-src", { remote: "https://github.com/acme/moved.git" });
    // Turn in the old location, hook fires, sync runs.
    await runStopHook(JSON.stringify({ session_id: "s7", cwd: before }), "claude-code", { spawnSync: () => {}, connected: async () => false });
    await writeTranscript(before, "s7", [line("s7", before, "req_H", 6, T0)]);
    await runSync({ full: false });
    expect(server.rows.get("req_H")?.metadata.repo).toMatchObject({ key: "github.com/acme/moved" });
    // The user moves the checkout, commits there, and works on.
    const after = join(fx.root, "moved-dst");
    await rename(before, after);
    const sha = await fx.commit(after, "c.txt", undefined, new Date());
    await writeTranscript(after, "s8", [line("s8", after, "req_I", 8, T0 + 300_000)]);
    await runSync({ full: false });
    expect(server.rows.get("req_I")?.metadata.repo).toMatchObject({ key: "github.com/acme/moved", label: "moved-dst" });
    // The pre-move session (its folder is gone) attributed to the commit made after the move.
    expect(server.attributions.find((a) => a.externalId === "req_H")).toMatchObject({ commitSha: sha });
  });

  it("against a server without capabilities the body is the 0.5.1 allowlist: usage numbers, no metadata", async () => {
    server.fields = [];
    await writeTranscript(repo, "s6", [line("s6", repo, "req_G", 2, T0 + 240_000)]);
    const attributesBefore = server.attributeBodies.length;
    await runSync({ full: false });
    // Fate rows too: the 0.5.1 four, no commit facts, no facts block.
    const fateBodies = server.attributeBodies.slice(attributesBefore).filter((b) => (b.fates ?? []).length > 0);
    expect(fateBodies.length).toBeGreaterThan(0);
    for (const b of fateBodies) {
      expect(b.facts).toBeUndefined();
      for (const f of b.fates!) expect(Object.keys(f).sort()).toEqual(["branch", "commitSha", "fate", "repoName"]);
    }
    const row = server.rows.get("req_G")!;
    expect(Object.keys(row).sort()).toEqual([
      "cacheCreation1hTokens", "cacheCreation5mTokens", "cacheCreationTokens", "cacheReadTokens",
      "externalId", "inputTokens", "model", "occurredAt", "outputTokens",
    ]);
    server.fields = ["repo"];
  });

  it("hideRepoNames and hideBranchNames reach the attribute route: repos, attributions and fates carry the events' hidden key and no branch", async () => {
    const saved = await readConfig();
    await writeConfig({ ...saved, hideRepoNames: true, hideBranchNames: true });
    try {
      const hush = await fx.repo("hush", { remote: "https://github.com/acme/hush.git" });
      await fx.git(hush, "checkout", "-q", "-b", "hush-branch");
      await writeTranscript(hush, "s9", [transcriptLine({ sessionId: "s9", cwd: hush, requestId: "req_J", out: 3, atMs: T0 + 360_000, gitBranch: "hush-branch" })]);
      const sha = await fx.commit(hush, "h.txt", undefined, new Date()); // after the event: it attributes here
      const ingestFrom = server.ingestBodies.length;
      const attributeFrom = server.attributeBodies.length;
      await runSync({ full: false });
      const sent = JSON.stringify([...server.ingestBodies.slice(ingestFrom), ...server.attributeBodies.slice(attributeFrom)]);
      expect(sent).not.toContain("hush"); // not the folder, the key, nor the branch
      const hidden = (server.rows.get("req_J")!.metadata.repo as { key: string }).key;
      expect(hidden).toMatch(/^hidden:[0-9a-f]{16}$/);
      const bodies = server.attributeBodies.slice(attributeFrom);
      expect(bodies.flatMap((b) => b.repos).filter((r) => r.key === hidden)).not.toHaveLength(0);
      expect(bodies.flatMap((b) => b.attributions).find((a) => a.externalId === "req_J")).toMatchObject({ repoKey: hidden, commitSha: sha, branch: null });
      // The fates carry the key the events carry, so a server that matches joins them.
      const fates = bodies.flatMap((b) => b.fates ?? []).filter((f) => f.commitSha === sha);
      expect(fates).toEqual([expect.objectContaining({ repoKey: hidden, branch: null })]);
      for (const r of [...bodies.flatMap((b) => b.repos), ...bodies.flatMap((b) => b.attributions), ...bodies.flatMap((b) => b.fates ?? [])]) {
        expect("name" in r ? r.name : r.repoName).not.toBe(""); // the server rejects an empty name
      }
    } finally {
      await writeConfig(saved);
    }
  });

  it("nothing on the wire ever carried the home path or hostname, whatever the server listed", () => {
    const { hostname } = require("node:os") as typeof import("node:os");
    for (const body of [...server.rows.values(), ...server.ingestBodies, ...server.attributeBodies]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(hostname());
      expect(text).not.toContain(home);
    }
  });
});
