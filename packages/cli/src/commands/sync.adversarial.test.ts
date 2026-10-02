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


describe("a dead worktree's repo still ships its commits when no session ever sat in the live checkout", () => {
  it.each([
    ["a server that matches", ["repo", "match"]],
    ["a server that does not", ["repo"]],
  ])("against %s", async (_, fields) => {
    server.fields = fields;
    const n = fields.length;
    const ws = join(fx.root, `ws-orphan-${n}`);
    await mkdir(ws);
    const main = await fx.repo(`ws-orphan-${n}/m`, { remote: `https://github.com/acme/orphan-${n}.git` });
    const wt = await fx.worktree(main, `ws-orphan-${n}/m-wt`, "wt");
    const t = (i: number) => T0 + 30 * 60_000 + i * 1000;
    const path = await writeTranscript(claudeDir, ws, `so${n}`, [
      JSON.stringify({ type: "user", timestamp: new Date(t(0)).toISOString(), cwd: ws, sessionId: `so${n}`, message: { role: "user", content: "go" } }),
      transcriptLine({ sessionId: `so${n}`, cwd: ws, requestId: `req_orphan_${n}`, out: 4, atMs: t(1), toolUse: { name: "Bash", input: { command: `cd ${wt} && make` } } }),
    ]);
    await runStopHook(JSON.stringify({ session_id: `so${n}`, cwd: ws, transcript_path: path }), "claude-code", { spawnSync: () => {}, connected: async () => false });
    const sha = await fx.commit(wt, "wt.txt", undefined, new Date());
    await fx.git(main, "worktree", "remove", "--force", wt);
    server.attributeBodies.length = 0;
    await runSync({ full: false });
    expect(server.rows.get(`req_orphan_${n}`)?.metadata.repo).toMatchObject({ key: `github.com/acme/orphan-${n}`, label: "m-wt" });
    // The live checkout `m` never hosted a session; the hook saw the worktree
    // and recorded where its main checkout lives. The fate pass and (when the
    // server does not match) the attribution both reach the commit through it.
    expect(server.fates.some((f) => f.commitSha === sha && f.repoKey === `github.com/acme/orphan-${n}`)).toBe(true);
    if (!fields.includes("match")) expect(server.attributions.find((a) => a.externalId === `req_orphan_${n}`)?.commitSha).toBe(sha);
    server.fields = ["repo"];
  });
});

describe("attributions follow the facts: what the CLI ships so the server can", () => {
  it("one fates call per repo with the machine id and completeness; `mine` per commit author; the sidecar branch replaces HEAD on the wire", async () => {
    server.fields = ["repo", "match"];
    const repo = await fx.repo("facts-own", { remote: "https://github.com/acme/facts-own.git" });
    await fx.git(repo, "config", "user.email", "T@Example.com"); // the fixture authors as t@example.com; case must not matter
    await fx.git(repo, "checkout", "-q", "-b", "feat/own");
    await writeTranscript(claudeDir, repo, "sm", [line("sm", repo, "req_mine", 3, T0, "HEAD")]);
    await hook("sm", repo);
    const mine = await fx.commit(repo, "mine.txt", undefined, new Date());
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { fixtureEnv } = await import("../testing/git-fixture.js");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(repo, "theirs.txt"), "x\n");
    await fx.git(repo, "add", "theirs.txt");
    await promisify(execFile)("git", ["-C", repo, "commit", "-q", "-m", "theirs"], { env: { ...fixtureEnv(fx.root), GIT_AUTHOR_EMAIL: "teammate@example.com", GIT_AUTHOR_DATE: new Date().toISOString(), GIT_COMMITTER_DATE: new Date().toISOString() } });
    const theirs = await fx.git(repo, "rev-parse", "HEAD");
    server.attributeBodies.length = 0;
    await runSync({ full: false });
    const calls = server.attributeBodies.filter((b) => (b.fates ?? []).length > 0) as Array<typeof server.attributeBodies[number] & { facts?: { machineId: string; complete: boolean } }>;
    const own = calls.find((b) => b.repos.some((r) => r.key === "github.com/acme/facts-own"))!;
    expect(own.repos).toHaveLength(1);
    expect(own.facts).toMatchObject({ complete: true });
    expect(own.facts?.machineId).toMatch(/^[0-9a-f-]{36}$/);
    expect(own.fates!.every((f) => f.repoKey === "github.com/acme/facts-own")).toBe(true);
    const byShaMine = Object.fromEntries(own.fates!.map((f) => [f.commitSha, (f as { mine?: boolean }).mine]));
    expect(byShaMine[mine]).toBe(true);
    expect(byShaMine[theirs]).toBe(false);
    expect(JSON.stringify(server.attributeBodies)).not.toContain("example.com"); // the email never leaves
    expect(server.rows.get("req_mine")?.metadata.gitBranch).toBe("feat/own");
    server.fields = ["repo"];
  });
});


describe("parallel sessions in one checkout, one branch", () => {
  it("two sessions' hooks racing, one commit after both: both attribute, both sidecar lines survive, one auto-sync between them", async () => {
    server.fields = ["repo"];
    const repo = await fx.repo("shared", { remote: "https://github.com/acme/shared.git" });
    const t = (i: number) => T0 + 40 * 60_000 + i * 1000;
    const ws = join(fx.root, "shared-ws");
    await mkdir(ws);
    // Session A inside the checkout; session B in a parent folder editing files in it.
    const pa = await writeTranscript(claudeDir, repo, "pa", [line("pa", repo, "req_pa", 2, t(0))]);
    const pb = await writeTranscript(claudeDir, ws, "pb", [
      JSON.stringify({ type: "user", timestamp: new Date(t(1)).toISOString(), cwd: ws, sessionId: "pb", message: { role: "user", content: "go" } }),
      transcriptLine({ sessionId: "pb", cwd: ws, requestId: "req_pb", out: 3, atMs: t(2), toolUse: { name: "Edit", input: { file_path: join(repo, "shared.ts"), old_string: "", new_string: "" } } }),
    ]);
    let spawns = 0;
    const claimPath = join(fx.root, "parallel.claim"); // fresh: the throttle test above already claimed the shared one
    const deps = (ms: number) => ({ now: () => new Date(Date.now() + ms), spawnSync: () => spawns++, connected: async () => true, claimPath });
    // Twelve hooks, both sessions interleaved, all in flight at once.
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        runStopHook(JSON.stringify({ session_id: i % 2 ? "pb" : "pa", cwd: i % 2 ? ws : repo, transcript_path: i % 2 ? pb : pa }), "claude-code", deps(i)),
      ),
    );
    expect(spawns).toBe(1);
    const { readSidecar } = await import("../sidecar.js");
    const { CONFIG_DIR } = await import("../config.js");
    const lines = await readSidecar(join(CONFIG_DIR, "sessions.jsonl"));
    expect(lines.get("pa")?.roots).toEqual({ [repo]: { key: "github.com/acme/shared", label: "shared", source: "remote", root: expect.stringMatching(/^[0-9a-f]{40}$/) } });
    expect(lines.get("pb")?.roots).toEqual({ [repo]: { key: "github.com/acme/shared", label: "shared", source: "remote", root: expect.stringMatching(/^[0-9a-f]{40}$/) } });
    const sha = await fx.commit(repo, "shared.ts", undefined, new Date());
    server.attributeBodies.length = 0;
    await runSync({ full: false });
    expect(server.rows.get("req_pa")?.metadata.placement).toBe("cwd");
    expect(server.rows.get("req_pb")?.metadata.placement).toBe("files");
    expect(server.attributions.filter((a) => a.commitSha === sha).map((a) => a.externalId).sort()).toEqual(["req_pa", "req_pb"]);
    expect(server.attributions.filter((a) => a.externalId === "req_pa")).toHaveLength(1); // never twice
  });
});

describe("a squash merge on the remote, branch deleted, stale origin/<branch> left behind", () => {
  it("branch commits read shipped as the squash commit, the squash commit reads shipped via origin/main, and a prune changes only which shas exist", async () => {
    server.fields = ["repo", "match"];
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { fixtureEnv } = await import("../testing/git-fixture.js");
    const { writeFile } = await import("node:fs/promises");
    const dated = (cwd: string, ...args: string[]) => {
      const iso = new Date().toISOString();
      return promisify(execFile)("git", ["-C", cwd, ...args], { env: { ...fixtureEnv(fx.root), GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } });
    };
    const bare = join(fx.root, "sq-origin.git");
    await fx.git(fx.root, "init", "-q", "--bare", "-b", "main", bare);
    const repo = await fx.repo("sq", { remote: bare });
    await fx.git(repo, "config", "user.email", "t@example.com");
    await fx.git(repo, "push", "-q", "-u", "origin", "main");
    await fx.git(repo, "remote", "set-head", "origin", "main");
    await writeTranscript(claudeDir, repo, "sq", [line("sq", repo, "req_sq", 1, T0 + 50 * 60_000)]);
    await hook("sq", repo);
    await fx.git(repo, "checkout", "-q", "-b", "feat");
    await writeFile(join(repo, "f1"), "1\n"); await fx.git(repo, "add", "f1"); await dated(repo, "commit", "-q", "-m", "one");
    const b1 = await fx.git(repo, "rev-parse", "HEAD");
    await writeFile(join(repo, "f2"), "2\n"); await fx.git(repo, "add", "f2"); await dated(repo, "commit", "-q", "-m", "two");
    const b2 = await fx.git(repo, "rev-parse", "HEAD");
    await fx.git(repo, "push", "-q", "-u", "origin", "feat");
    const gh = join(fx.root, "sq-gh");
    await fx.git(fx.root, "clone", "-q", bare, gh);
    await fx.git(gh, "config", "user.email", "t@example.com");
    await fx.git(gh, "merge", "--squash", "-q", "origin/feat");
    await dated(gh, "commit", "-q", "-m", "feat (#1)");
    const squash = await fx.git(gh, "rev-parse", "HEAD");
    await fx.git(gh, "push", "-q", "origin", "main");
    await fx.git(gh, "push", "-q", "origin", "--delete", "feat");
    await fx.git(repo, "fetch", "-q", "origin");
    await fx.git(repo, "switch", "-q", "--detach", "origin/main");
    await fx.git(repo, "branch", "-D", "feat");
    server.attributeBodies.length = 0;
    await runSync({ full: true });
    const fate = (sha: string) => server.fates.find((f) => f.commitSha === sha) as { fate: string; mergedAs?: string } | undefined;
    expect(fate(squash)?.fate).toBe("shipped"); // via origin/main, even though local main is stale
    expect(fate(b1)).toMatchObject({ fate: "shipped", mergedAs: squash });
    expect(fate(b2)).toMatchObject({ fate: "shipped", mergedAs: squash });
    await fx.git(repo, "fetch", "-q", "--prune", "origin");
    server.attributeBodies.length = 0;
    await runSync({ full: true });
    expect(server.fates.map((f) => f.commitSha).filter((s) => [b1, b2, squash].includes(s))).toEqual([squash]);
    expect(fate(squash)?.fate).toBe("shipped");
    // A server that does not list "patch-id" never sees a patch id.
    expect(JSON.stringify(server.attributeBodies)).not.toMatch(/patchId|branchPatchId/);
    server.fields = ["repo"];
  });

  it("a server that lists \"patch-id\" gets the proof instead: the squash's patchId is the branch tip's branchPatchId, and it outlives the branch", async () => {
    server.fields = ["repo", "match", "patch-id"];
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { fixtureEnv } = await import("../testing/git-fixture.js");
    const { writeFile } = await import("node:fs/promises");
    const dated = (cwd: string, ...args: string[]) => {
      const iso = new Date().toISOString();
      return promisify(execFile)("git", ["-C", cwd, ...args], { env: { ...fixtureEnv(fx.root), GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } });
    };
    const commitOn = async (repo: string, file: string) => {
      await writeFile(join(repo, file), `${file}\n`);
      await fx.git(repo, "add", file);
      await dated(repo, "commit", "-q", "-m", file);
      return fx.git(repo, "rev-parse", "HEAD");
    };
    const repo = await fx.repo("pid", { remote: "https://github.com/acme/pid.git" });
    await fx.git(repo, "config", "user.email", "t@example.com");
    await writeTranscript(claudeDir, repo, "pid", [line("pid", repo, "req_pid", 1, T0 + 55 * 60_000, "feat")]);
    await hook("pid", repo);
    await fx.git(repo, "checkout", "-q", "-b", "feat");
    const b1 = await commitOn(repo, "p1");
    const b2 = await commitOn(repo, "p2");
    await fx.git(repo, "checkout", "-q", "main");
    const unrelated = await commitOn(repo, "unrelated");
    await fx.git(repo, "merge", "--squash", "-q", "feat");
    await dated(repo, "commit", "-q", "-m", "feat (#1)");
    const squash = await fx.git(repo, "rev-parse", "HEAD");
    type Row = { fate: string; patchId?: string; branchPatchId?: string; mergedAs?: string };
    const fate = (sha: string) => server.fates.find((f) => f.commitSha === sha) as Row | undefined;
    server.attributeBodies.length = 0;
    await runSync({ full: true });
    expect(fate(squash)?.patchId).toMatch(/^[0-9a-f]{40}$/);
    expect(fate(squash)?.patchId).toBe(fate(b2)?.branchPatchId);
    expect(fate(b1)).toMatchObject({ fate: "shipped", mergedAs: squash, patchId: fate(b1)?.branchPatchId });
    expect(fate(b2)?.branchPatchId).not.toBe(fate(b2)?.patchId);
    expect(fate(unrelated)?.branchPatchId).toBeUndefined(); // on the default branch
    const proof = fate(squash)?.patchId;
    // The branch is deleted: its commits vanish, the squash's proof stays.
    await fx.git(repo, "branch", "-D", "feat");
    server.attributeBodies.length = 0;
    await runSync({ full: true });
    expect(fate(b1)).toBeUndefined();
    expect(fate(squash)?.patchId).toBe(proof);
    server.fields = ["repo"];
  });
});

describe("two live clones of one repo on one machine", () => {
  it("send ONE complete fact set for the key (the union of both clones' commits), so neither clone's unpushed commits read as vanished", async () => {
    server.fields = ["repo", "match"];
    const bare = join(fx.root, "tc-origin.git");
    await fx.git(fx.root, "init", "-q", "--bare", "-b", "main", bare);
    const a = await fx.repo("tc-a", { remote: bare });
    await fx.git(a, "push", "-q", "-u", "origin", "main");
    const b = join(fx.root, "tc-b");
    await fx.git(fx.root, "clone", "-q", bare, b);
    for (const r of [a, b]) await fx.git(r, "config", "user.email", "t@example.com");
    const t = (i: number) => T0 + 60 * 60_000 + i * 1000;
    await writeTranscript(claudeDir, a, "ta", [line("ta", a, "req_ta", 1, t(0))]);
    await writeTranscript(claudeDir, b, "tb", [line("tb", b, "req_tb", 1, t(1))]);
    await hook("ta", a);
    await hook("tb", b);
    const shaA = await fx.commit(a, "a-only.txt", undefined, new Date()); // unpushed, only in clone a
    const shaB = await fx.commit(b, "b-only.txt", undefined, new Date()); // unpushed, only in clone b
    server.attributeBodies.length = 0;
    await runSync({ full: true });
    const key = "sha:" + (await fx.git(a, "rev-list", "--max-parents=0", "refs/heads/main"));
    const calls = server.attributeBodies.filter((c) => (c.fates ?? []).some((f) => f.repoKey === key));
    expect(calls).toHaveLength(1);
    const shas = new Set(calls[0].fates!.map((f) => f.commitSha));
    expect(shas.has(shaA) && shas.has(shaB)).toBe(true);
    expect((calls[0] as { facts?: { complete: boolean } }).facts?.complete).toBe(true);
    server.fields = ["repo"];
  });
});

describe("a machine offline for a week", () => {
  // Ten syncs, one of them full, over every repo this file has built so far:
  // slow by construction, so it gets more than the default five seconds.
  it("failed syncs leave the watermark; the first online sync lands everything once; a flaky capabilities call never downgrades the body to the 0.5 shape", { timeout: 30_000 }, async () => {
    server.fields = ["repo"];
    const repo = await fx.repo("offline", { remote: "https://github.com/acme/offline.git" });
    const t = (i: number) => T0 + 70 * 60_000 + i * 1000;
    const { readState, writeAuth: setAuth } = await import("../config.js");
    // Online once, so the server's identity-aware capabilities are known.
    await writeTranscript(claudeDir, repo, "off", [line("off", repo, "req_off0", 1, t(0))]);
    await runSync({ full: false });
    const markOnline = (await readState()).surfaces["claude-code"];
    // Offline: the base URL points at a closed port. Seven days of turns accumulate.
    await setAuth({ baseUrl: "http://127.0.0.1:9", token: "t", deviceName: "adv" });
    const lines = [line("off", repo, "req_off0", 1, t(0))];
    for (let d = 1; d <= 7; d++) {
      lines.push(line("off", repo, `req_off${d}`, d, t(d)));
      await writeTranscript(claudeDir, repo, "off", lines);
      await hook("off", repo);
      await expect(runSync({ full: false })).rejects.toThrow();
      expect((await readState()).surfaces["claude-code"]).toBe(markOnline);
    }
    // Back online, but the capabilities endpoint fails while ingest works.
    await setAuth({ baseUrl: server.url, token: "t", deviceName: "adv" });
    server.failCapabilities = true;
    const before = server.ingestBodies.length;
    await runSync({ full: false });
    server.failCapabilities = false;
    const sent = server.ingestBodies.slice(before).flatMap((b) => b.events as Array<{ externalId: string; metadata: Record<string, unknown> }>).filter((e) => e.externalId.startsWith("req_off"));
    expect(sent.map((e) => e.externalId).sort().join(",")).toBe(Array.from({ length: 8 }, (_, i) => `req_off${i}`).sort().join(","));
    for (const e of sent) {
      expect(e.metadata.cwd).toBeUndefined(); // never the 0.5 shape once identity-aware was seen
      expect(e.metadata.repo).toMatchObject({ key: "github.com/acme/offline" });
    }
    // And nothing lands twice.
    await runSync({ full: true });
    expect([...server.rows.keys()].filter((k) => k.startsWith("req_off"))).toHaveLength(8);
  });
});

describe("cherry-picks and reverts", () => {
  const dated = async (cwd: string, ...args: string[]) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { fixtureEnv } = await import("../testing/git-fixture.js");
    const iso = new Date().toISOString();
    return promisify(execFile)("git", ["-C", cwd, ...args], { env: { ...fixtureEnv(fx.root), GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } });
  };
  const commitOn = async (repo: string, file: string) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(repo, file), `${file}\n`);
    await fx.git(repo, "add", file);
    await dated(repo, "commit", "-q", "-m", file);
    return fx.git(repo, "rev-parse", "HEAD");
  };
  const fateOf = (sha: string) => server.fates.find((f) => f.commitSha === sha) as { fate: string; mergedAs?: string; mine?: boolean } | undefined;

  it("a whole branch cherry-picked onto main ships as the pick; a single middle commit picked ships alone, its neighbours stay in flight", async () => {
    server.fields = ["repo", "match"];
    const repo = await fx.repo("cp", { remote: "https://github.com/acme/cp.git" });
    await fx.git(repo, "config", "user.email", "t@example.com");
    await writeTranscript(claudeDir, repo, "cp", [line("cp", repo, "req_cp", 1, T0 + 80 * 60_000)]);
    await hook("cp", repo);
    await fx.git(repo, "checkout", "-q", "-b", "one");
    const c = await commitOn(repo, "c.txt");
    await fx.git(repo, "checkout", "-q", "main");
    // Main moves first: a pick onto an unmoved parent in the same second is
    // the byte-identical commit (same parent, tree, message, dates) — the
    // branch commit itself, an ancestor, shipped with nothing to roll into.
    await commitOn(repo, "main-moves.txt");
    await dated(repo, "cherry-pick", c);
    const cPick = await fx.git(repo, "rev-parse", "HEAD");
    expect(cPick).not.toBe(c);
    await fx.git(repo, "checkout", "-q", "-b", "three", "main");
    const b1 = await commitOn(repo, "b1.txt");
    const b2 = await commitOn(repo, "b2.txt");
    const b3 = await commitOn(repo, "b3.txt");
    await fx.git(repo, "checkout", "-q", "main");
    await dated(repo, "cherry-pick", b2);
    const b2Pick = await fx.git(repo, "rev-parse", "HEAD");
    server.attributeBodies.length = 0;
    await runSync({ full: true });
    expect(fateOf(c)).toMatchObject({ fate: "shipped", mergedAs: cPick });
    expect(fateOf(cPick)?.fate).toBe("shipped");
    expect(fateOf(b2)?.fate).toBe("shipped"); // cherry-equivalent: shipped, but nothing to roll into
    expect(fateOf(b2)?.mergedAs).toBeUndefined();
    expect(fateOf(b2Pick)?.fate).toBe("shipped");
    expect(fateOf(b1)?.fate).toBe("in_flight");
    expect(fateOf(b3)?.fate).toBe("in_flight");
    server.fields = ["repo"];
  });

  it("a reverted commit stays shipped (a bound: there is no reverted fate); tokens after it and before the revert attribute to the revert", async () => {
    server.fields = ["repo"];
    const repo = await fx.repo("rv", { remote: "https://github.com/acme/rv.git" });
    await fx.git(repo, "config", "user.email", "t@example.com");
    await writeTranscript(claudeDir, repo, "rv", [line("rv", repo, "req_rv_before", 1, Date.now() - 120_000)]);
    await hook("rv", repo);
    const c = await commitOn(repo, "rv.txt");
    await new Promise((r) => setTimeout(r, 1100)); // a second between the commit and the next event
    await writeTranscript(claudeDir, repo, "rv", [line("rv", repo, "req_rv_before", 1, Date.now() - 120_000), line("rv", repo, "req_rv_after", 1, Date.now())]);
    await new Promise((r) => setTimeout(r, 1100));
    await dated(repo, "revert", "--no-edit", c);
    const r = await fx.git(repo, "rev-parse", "HEAD");
    server.attributeBodies.length = 0;
    await runSync({ full: true });
    expect(fateOf(c)?.fate).toBe("shipped");
    expect(fateOf(r)).toMatchObject({ fate: "shipped", mine: true });
    const attr = (id: string) => server.attributions.filter((a) => a.externalId === id).map((a) => a.commitSha);
    expect(attr("req_rv_before")).toEqual([c]);
    expect(attr("req_rv_after")).toEqual([r]);
  });
});

describe("symlinked paths", () => {
  it("a turn that edits through a symlinked path still places after the worktree is gone", async () => {
    server.fields = ["repo"];
    const { symlink } = await import("node:fs/promises");
    const main = await fx.repo("sym/m", { remote: "https://github.com/acme/sym.git" });
    const wt = await fx.worktree(main, "sym/m-wt", "wt");
    const link = join(fx.root, "sym-link");
    await symlink(join(fx.root, "sym"), link); // ~/code → /mnt/data/code, /tmp → /private/tmp
    const ws = join(fx.root, "sym-ws");
    await mkdir(ws);
    const t = (i: number) => T0 + 90 * 60_000 + i * 1000;
    const logical = join(link, "m-wt", "src", "x.ts"); // what the model typed
    const path = await writeTranscript(claudeDir, ws, "sy", [
      JSON.stringify({ type: "user", timestamp: new Date(t(0)).toISOString(), cwd: ws, sessionId: "sy", message: { role: "user", content: "go" } }),
      transcriptLine({ sessionId: "sy", cwd: ws, requestId: "req_sym", out: 1, atMs: t(1), toolUse: { name: "Edit", input: { file_path: logical, old_string: "", new_string: "" } } }),
    ]);
    await runStopHook(JSON.stringify({ session_id: "sy", cwd: ws, transcript_path: path }), "claude-code", { spawnSync: () => {}, connected: async () => false });
    await fx.git(main, "worktree", "remove", "--force", wt);
    await runSync({ full: false });
    expect(server.rows.get("req_sym")?.metadata).toMatchObject({ repo: { key: "github.com/acme/sym", label: "m-wt" }, placement: "files" });
  });
});

describe("where transcripts live", () => {
  it("a hook whose environment was scrubbed (CLAUDE_CODE_SUBPROCESS_ENV_SCRUB) still gets its relocated transcripts synced: the sidecar remembers the config dir", async () => {
    server.fields = ["repo"];
    const repo = await fx.repo("reloc", { remote: "https://github.com/acme/reloc.git" });
    const relocated = join(home, "claude-relocated");
    const path = await writeTranscript(relocated, repo, "rl", [line("rl", repo, "req_reloc", 1, T0 + 100 * 60_000)]);
    await runStopHook(JSON.stringify({ session_id: "rl", cwd: repo, transcript_path: path }), "claude-code", { spawnSync: () => {}, connected: async () => false });
    // The background sync inherits the scrubbed environment: CLAUDE_CONFIG_DIR is the default one.
    await runSync({ full: false });
    expect(server.rows.get("req_reloc")?.metadata.repo).toMatchObject({ key: "github.com/acme/reloc" });
  });

  it("a subagent that edited a worktree which died before sync: its turn still places by files", async () => {
    server.fields = ["repo"];
    const main = await fx.repo("sub/m", { remote: "https://github.com/acme/sub.git" });
    const wt = await fx.worktree(main, "sub/m-wt", "wt");
    const ws = join(fx.root, "sub-ws");
    await mkdir(ws);
    const t = (i: number) => T0 + 110 * 60_000 + i * 1000;
    const path = await writeTranscript(claudeDir, ws, "sa", [
      JSON.stringify({ type: "user", timestamp: new Date(t(0)).toISOString(), cwd: ws, sessionId: "sa", message: { role: "user", content: "go" } }),
      transcriptLine({ sessionId: "sa", cwd: ws, requestId: "req_parent", out: 1, atMs: t(1), toolUse: { name: "Agent", input: { prompt: "edit it" } } }),
    ]);
    // Claude Code writes the subagent's transcript beside the session: <project>/<session>/subagents/<agent>.jsonl
    const { writeFile } = await import("node:fs/promises");
    const subDir = join(path.replace(/\.jsonl$/, ""), "subagents");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "agent-1.jsonl"), `${[
      JSON.stringify({ type: "user", timestamp: new Date(t(2)).toISOString(), cwd: ws, sessionId: "sa", isSidechain: true, message: { role: "user", content: "edit it" } }),
      transcriptLine({ sessionId: "sa", cwd: ws, requestId: "req_sub", out: 1, atMs: t(3), toolUse: { name: "Edit", input: { file_path: join(wt, "x.ts"), old_string: "", new_string: "" } } }),
    ].join("\n")}\n`);
    await runStopHook(JSON.stringify({ session_id: "sa", cwd: ws, transcript_path: path }), "claude-code", { spawnSync: () => {}, connected: async () => false });
    await fx.git(main, "worktree", "remove", "--force", wt);
    await runSync({ full: false });
    expect(server.rows.get("req_sub")?.metadata).toMatchObject({ repo: { key: "github.com/acme/sub", label: "m-wt" }, placement: "files" });
  });
});
