// Adversarial harness: every case is an attempt to make the shipped truth
// differ from the transcript's — duplicated, misattributed, lost, or
// leaking a path or username — across the real runSync / runStopHook,
// real git and real files, against the stand-in server.
import { hostname } from "node:os";
import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scratch, type Scratch } from "../testing/git-fixture.js";
import { StandIn, transcriptLine, writeTranscript } from "../testing/stand-in-server.js";

const home = await mkdtemp(join(tmpdir(), "centrail-adv-"));
const claudeDir = join(home, "claude");
const fakeHome = join(home, "jane"); // a username-shaped home directory
process.env.HOME = fakeHome;
process.env.CENTRAIL_CONFIG_DIR = join(home, "cfg");
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.CODEX_HOME = join(home, "codex");
const { runSync } = await import("./sync.js");
const { runStopHook, AUTO_SYNC_INTERVAL_MS } = await import("./hook.js");
const { runExclude } = await import("./scope.js");
const { writeAuth, writeConfig, parseConfig, readState } = await import("../config.js");

const T0 = Date.now() - 60 * 60 * 1000;
let seq = 0;
const line = (sessionId: string, cwd: string, requestId: string, out: number, atMs = T0 + seq++ * 1000, gitBranch?: string) =>
  transcriptLine({ sessionId, cwd, requestId, out, atMs, gitBranch });
const hook = (sessionId: string, cwd: string) =>
  runStopHook(JSON.stringify({ session_id: sessionId, cwd }), "claude-code", { spawnSync: () => {}, connected: async () => false });

let fx: Scratch;
const server = new StandIn();

beforeAll(async () => {
  await server.start();
  fx = await scratch();
  await mkdir(fakeHome, { recursive: true });
  await writeAuth({ baseUrl: server.url, token: "t", deviceName: "adv" });
  await writeConfig(parseConfig({ surfaces: { "copilot-cli": false }, scopeDecidedAt: "2026-06-01T00:00:00Z" }));
});
afterAll(async () => {
  server.close();
  await fx.cleanup();
  await rm(home, { recursive: true, force: true });
});

describe("attribution never crosses branches", () => {
  it("two sessions in two worktrees on two branches each attribute to their own commit, before and after one worktree dies", async () => {
    const repo = await fx.repo("repo", { remote: "https://github.com/acme/repo.git" });
    const wtA = await fx.worktree(repo, "repo-a", "feat-a");
    const wtB = await fx.worktree(repo, "repo-b", "feat-b");
    // Both sessions run, both hooks fire, then each worktree commits — B first, so
    // a time-only matcher over `--all` would hand A's event to B's commit.
    await writeTranscript(claudeDir, wtA, "sa", [line("sa", wtA, "req_a", 5, T0)]);
    await writeTranscript(claudeDir, wtB, "sb", [line("sb", wtB, "req_b", 6, T0)]);
    await hook("sa", wtA);
    await hook("sb", wtB);
    const shaB = await fx.commit(wtB, "b.txt", undefined, new Date(Date.now() - 30_000));
    const shaA = await fx.commit(wtA, "feat-a.txt", undefined, new Date());
    await runSync({ full: false });
    const attr = (id: string) => server.attributions.filter((a) => a.externalId === id).map((a) => a.commitSha);
    expect(attr("req_a")).toEqual([shaA]);
    expect(attr("req_b")).toEqual([shaB]);

    // B's worktree dies. Its event must still find shaB — via feat-b in a
    // sibling — and never shaA, which is what `--all` would offer first.
    await fx.git(repo, "worktree", "remove", "--force", wtB);
    server.attributeBodies.length = 0;
    await runSync({ full: true });
    expect(attr("req_b")).toEqual([shaB]);
    expect(attr("req_a")).toEqual([shaA]);
    expect(server.rows.get("req_b")?.metadata.repo).toMatchObject({ key: "github.com/acme/repo", label: "repo-b" });
  });
});

describe("the Stop hook throttle", () => {
  it("N hooks inside the interval start one sync; the first past it starts another; a stepped-back clock does not silence it", async () => {
    const repo = await fx.repo("throttle", { remote: "https://github.com/acme/throttle.git" });
    let spawns = 0;
    const at = (ms: number) => ({ now: () => new Date(T0 + ms), spawnSync: () => spawns++, connected: async () => true });
    const fire = (i: number, ms: number) => runStopHook(JSON.stringify({ session_id: `t${i}`, cwd: repo }), "claude-code", at(ms));
    for (let i = 0; i < 5; i++) await fire(i, i * 60_000); // 0..4 min
    expect(spawns).toBe(1);
    await fire(5, AUTO_SYNC_INTERVAL_MS - 1);
    expect(spawns).toBe(1);
    await fire(6, AUTO_SYNC_INTERVAL_MS);
    expect(spawns).toBe(2);
    // The clock steps back an hour: the stamp is now in the future.
    await fire(7, AUTO_SYNC_INTERVAL_MS - 60 * 60 * 1000);
    expect(spawns).toBe(3);
    expect((await readState()).autoSyncAt).toBe(new Date(T0 + AUTO_SYNC_INTERVAL_MS - 60 * 60 * 1000).toISOString());
  });
});

describe("exclude means nothing about the repo leaves", () => {
  it("an excluded repo's events, commits, repo row and fate rows are all absent, while a sibling repo's all arrive", async () => {
    const secret = await fx.repo("secret", { remote: "https://github.com/acme/secret.git" });
    const open = await fx.repo("open", { remote: "https://github.com/acme/open.git" });
    await runExclude("github.com/acme/secret");
    await writeTranscript(claudeDir, secret, "ss", [line("ss", secret, "req_secret", 5, T0)]);
    await writeTranscript(claudeDir, open, "so", [line("so", open, "req_open", 5, T0)]);
    await hook("ss", secret);
    await hook("so", open);
    const shaS = await fx.commit(secret, "s.txt", undefined, new Date());
    const shaO = await fx.commit(open, "o.txt", undefined, new Date());
    server.attributeBodies.length = 0;
    await runSync({ full: true });
    const wire = JSON.stringify([...server.ingestBodies, ...server.attributeBodies]);
    expect(server.rows.has("req_secret")).toBe(false);
    expect(wire).not.toContain("acme/secret");
    expect(wire).not.toContain(shaS);
    expect(wire).not.toContain(basename(secret));
    expect(server.rows.get("req_open")?.metadata.repo).toMatchObject({ key: "github.com/acme/open" });
    expect(server.attributions.find((a) => a.externalId === "req_open")?.commitSha).toBe(shaO);
    expect(server.repos.map((r) => r.key)).toContain("github.com/acme/open");
    expect(server.fates.some((f) => f.commitSha === shaO)).toBe(true);
  });
});

describe("more collection must not mean more rows", () => {
  it("the same transcript reachable through two CLAUDE_CONFIG_DIR entries lands once", async () => {
    const repo = await fx.repo("dup", { remote: "https://github.com/acme/dup.git" });
    const second = join(home, "claude-2");
    await writeTranscript(claudeDir, repo, "sd", [line("sd", repo, "req_dup", 8, T0)]);
    await writeTranscript(second, repo, "sd", [line("sd", repo, "req_dup", 8, T0)]);
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = `${claudeDir},${second}`;
    try {
      const before = server.ingestBodies.length;
      await runSync({ full: true });
      const sent = server.ingestBodies.slice(before).flatMap((b) => (b.events as Array<{ externalId: string }>).map((e) => e.externalId));
      expect(sent.filter((id) => id === "req_dup")).toHaveLength(1);
      expect(server.out("req_dup")).toBe(8);
    } finally {
      process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  it("a worktree deleted before any hook saw it still ships — unidentified, with no path — and a deleted transcript changes nothing", async () => {
    const repo = await fx.repo("gone", { remote: "https://github.com/acme/gone.git" });
    const wt = await fx.worktree(repo, "gone-wt", "wt");
    await writeTranscript(claudeDir, wt, "sg", [line("sg", wt, "req_gone", 3, T0)]);
    await fx.git(repo, "worktree", "remove", "--force", wt);
    await runSync({ full: false });
    const row = server.rows.get("req_gone")!;
    expect(row).toBeDefined();
    expect(row.metadata.repo).toBeUndefined(); // the Inbox's problem, honestly
    expect(row.metadata.cwd).toBeUndefined();
    // The transcript itself is swept.
    await unlink(join(claudeDir, "projects", wt.replace(/[/.]/g, "-"), "sg.jsonl"));
    const rowsBefore = new Map(server.rows);
    await runSync({ full: true });
    expect(server.rows).toEqual(rowsBefore);
  });
});

describe("the username never leaves", () => {
  it.each([
    ["a session in the home directory itself", async () => fakeHome],
    ["a dotfiles repo checked out at the home directory", async () => {
      await fx.git(fakeHome, "init", "-q", "-b", "main");
      await fx.git(fakeHome, "remote", "add", "origin", "https://github.com/acme/dotfiles.git");
      return fakeHome;
    }],
  ])("%s: no label, path or hostname on the wire carries it", async (name, setup) => {
    const cwd = await setup();
    const id = `req_${name.length}`;
    await writeTranscript(claudeDir, cwd, `sh${name.length}`, [line(`sh${name.length}`, cwd, id, 2, T0)]);
    await hook(`sh${name.length}`, cwd);
    await runSync({ full: false });
    const row = server.rows.get(id)!;
    expect(row.metadata.repo).toMatchObject({ label: "~" });
    const text = JSON.stringify(row);
    expect(text).not.toContain("jane");
    expect(text).not.toContain(home);
    expect(text).not.toContain(hostname());
  });
});

describe("§ 3.9 placement: sessions outside a repo find their home", () => {
  const toolLine = (sessionId: string, cwd: string, requestId: string, atMs: number, name: string, input: Record<string, unknown>) =>
    transcriptLine({ sessionId, cwd, requestId, out: 1, atMs, toolUse: { name, input } });
  const userLine = (sessionId: string, cwd: string, atMs: number) =>
    JSON.stringify({ type: "user", timestamp: new Date(atMs).toISOString(), cwd, sessionId, message: { role: "user", content: "go" } });
  const placementOf = (id: string) => [(server.rows.get(id)?.metadata.repo as { key?: string } | undefined)?.key, server.rows.get(id)?.metadata.placement];

  it("parent-folder session across two repos: each turn placed by its files, a text-only turn sticky, all through the hook's offset, surviving a deleted worktree and a full rescan", async () => {
    const ws = join(fx.root, "ws");
    await mkdir(ws);
    const a = await fx.repo("ws/a", { remote: "https://github.com/acme/a.git" });
    const b = await fx.repo("ws/b", { remote: "https://github.com/acme/b.git" });
    const bwt = await fx.worktree(b, "ws/b-wt", "wt");
    const t = (i: number) => T0 + 10 * 60_000 + i * 1000;
    const lines = [
      userLine("sp", ws, t(0)),
      line("sp", ws, "req_p1", 1, t(1)), // thinking, before any tool call
      toolLine("sp", ws, "req_p2", t(2), "Edit", { file_path: join(a, "src", "x.ts"), old_string: "", new_string: "" }),
      userLine("sp", ws, t(3)),
      toolLine("sp", ws, "req_p3", t(4), "Bash", { command: `cd ${bwt} && npm test` }), // Bash-only turn, in the worktree
      userLine("sp", ws, t(5)),
      line("sp", ws, "req_p4", 1, t(6)), // text only: sticky
    ];
    const path = await writeTranscript(claudeDir, ws, "sp", lines.slice(0, 3));
    await runStopHook(JSON.stringify({ session_id: "sp", cwd: ws, transcript_path: path }), "claude-code", { spawnSync: () => {}, connected: async () => false });
    await writeTranscript(claudeDir, ws, "sp", lines);
    await runStopHook(JSON.stringify({ session_id: "sp", cwd: ws, transcript_path: path }), "claude-code", { spawnSync: () => {}, connected: async () => false });
    await fx.git(b, "worktree", "remove", "--force", bwt); // gone before sync
    await runSync({ full: false });
    expect(placementOf("req_p1")).toEqual(["github.com/acme/a", "files"]);
    expect(placementOf("req_p2")).toEqual(["github.com/acme/a", "files"]);
    expect(placementOf("req_p3")).toEqual(["github.com/acme/b", "files"]);
    expect(server.rows.get("req_p3")?.metadata.repo).toMatchObject({ label: "b-wt" });
    expect(placementOf("req_p4")).toEqual(["github.com/acme/b", "sticky"]);
    // Nothing local leaves: touched paths and turn ids stay on the machine.
    for (const id of ["req_p1", "req_p2", "req_p3", "req_p4"]) {
      const text = JSON.stringify(server.rows.get(id));
      expect(text).not.toContain(ws);
      expect(text).not.toContain("touched");
      expect(text).not.toContain('"turn"');
    }
    // A full rescan with repo a also gone places identically.
    await rm(a, { recursive: true, force: true });
    const before = [...server.rows].map(([k, v]) => [k, v.metadata.repo, v.metadata.placement]);
    await runSync({ full: true });
    expect([...server.rows].map(([k, v]) => [k, v.metadata.repo, v.metadata.placement])).toEqual(before);
  });

  it("a session inside a repo is placed by cwd whatever it touches; a session in a folder with no evidence is the folder", async () => {
    const inside = await fx.repo("inside", { remote: "https://github.com/acme/inside.git" });
    const other = await fx.repo("other2", { remote: "https://github.com/acme/other2.git" });
    const plain = join(fx.root, "plain");
    await mkdir(plain);
    const t = (i: number) => T0 + 20 * 60_000 + i * 1000;
    await writeTranscript(claudeDir, inside, "si", [userLine("si", inside, t(0)), toolLine("si", inside, "req_i1", t(1), "Write", { file_path: join(other, "z.ts"), content: "" })]);
    await writeTranscript(claudeDir, plain, "sq", [userLine("sq", plain, t(2)), line("sq", plain, "req_q1", 1, t(3))]);
    await runSync({ full: false });
    expect(placementOf("req_i1")).toEqual(["github.com/acme/inside", "cwd"]);
    expect(placementOf("req_q1")[1]).toBe("folder");
    expect((server.rows.get("req_q1")?.metadata.repo as { key: string }).key).toMatch(/^dir:/);
  });
});

describe("§ 3.8 the server matches; the CLI ships commit facts", () => {
  it.each([
    ["a server that matches", ["repo", "match"], false],
    ["a server that does not", ["repo"], true],
  ])("against %s: fate rows carry committedAt and line counts; attribution rows are sent only when the server cannot match", async (_, fields, cliMatches) => {
    server.fields = fields;
    const repo = await fx.repo(`facts-${fields.length}`, { remote: `https://github.com/acme/facts-${fields.length}.git` });
    const id = `req_facts_${fields.length}`;
    await writeTranscript(claudeDir, repo, `sf${fields.length}`, [line(`sf${fields.length}`, repo, id, 3, T0)]);
    await hook(`sf${fields.length}`, repo);
    const sha = await fx.commit(repo, "facts.txt", "one\ntwo\n", new Date());
    server.attributeBodies.length = 0;
    await runSync({ full: false });
    const fate = server.fates.find((f) => f.commitSha === sha) as (typeof server.fates)[number] & { committedAt?: string; linesAdded?: number; linesDeleted?: number; filesChanged?: number };
    expect(fate).toMatchObject({ repoKey: `github.com/acme/facts-${fields.length}`, linesAdded: 2, linesDeleted: 0, filesChanged: 1 });
    expect(Math.abs(new Date(fate.committedAt!).getTime() - Date.now())).toBeLessThan(5 * 60_000);
    expect(server.attributions.some((a) => a.externalId === id)).toBe(cliMatches);
    // The repos are declared either way — with the attributions, or with the first fates call.
    expect(server.repos.map((r) => r.key)).toContain(`github.com/acme/facts-${fields.length}`);
    server.fields = ["repo"];
  });
});

