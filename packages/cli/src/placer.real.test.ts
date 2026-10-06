// The placer's decision order over real folders (§ 3.9):
//   cwd inside a repo → its turn's edits name one → its reads name one →
//   the session's previous placement (sticky) → the folder id.
// Each case tries to make it pick the wrong home or split a turn.
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Evidence, ParsedUsageEvent } from "@centrail/parsers";
import { afterEach, describe, expect, it } from "vitest";
import { Placer } from "./placer.js";
import { IdentityResolver } from "./resolver.js";
import { appendSidecar } from "./sidecar.js";
import { scratch, type Scratch } from "./testing/git-fixture.js";

let fx: Scratch;
afterEach(async () => {
  await fx?.cleanup();
});

let n = 0;
function ev(o: { cwd: string; sessionId?: string; turn?: string; at?: number; touched?: Partial<Evidence> }): ParsedUsageEvent {
  n++;
  return {
    externalId: `req_${n}`,
    provider: "anthropic",
    model: "m",
    inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0,
    occurredAt: new Date(Date.UTC(2026, 5, 1, 12, 0, o.at ?? n)),
    metadata: { cwd: o.cwd, sessionId: o.sessionId ?? "s", turn: o.turn, touched: { writes: o.touched?.writes ?? [], reads: o.touched?.reads ?? [] } },
  };
}
const placed = (e: ParsedUsageEvent) => [e.metadata.repo?.key, e.metadata.placement];

type World = { ws: string; a: string; b: string; placer: Placer; sidecar: string };
async function world(): Promise<World> {
  fx = await scratch();
  const ws = join(fx.root, "ws"); // a workstream root: not a repo, holds two
  await mkdir(ws);
  const a = await fx.repo("ws/a", { remote: "https://github.com/acme/a.git" });
  const b = await fx.repo("ws/b", { remote: "https://github.com/acme/b.git" });
  const sidecar = join(fx.root, "sessions.jsonl");
  const placer = new Placer(await IdentityResolver.create("install", sidecar));
  return { ws, a, b, placer, sidecar };
}

// A superproject `a` with a submodule at vendor/lib, its own repo.
async function withSubmodule(): Promise<World & { sub: string }> {
  const w = await world();
  const lib = await fx.repo("lib-src");
  await fx.git(w.a, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib");
  await fx.git(w.a, "commit", "-q", "-m", "add lib");
  const sub = join(w.a, "vendor", "lib");
  await fx.git(sub, "remote", "set-url", "origin", "https://github.com/acme/lib.git");
  return { ...w, sub };
}

describe("Placer", () => {
  it("cwd inside a repo wins over every file the turn touched elsewhere", async () => {
    const { a, b, placer } = await world();
    const e = ev({ cwd: a, turn: "t1", touched: { writes: [join(b, "x.ts")], reads: [join(b, "y.ts")] } });
    await placer.place([e]);
    expect(placed(e)).toEqual(["github.com/acme/a", "cwd"]);
  });

  it.each([
    ["edits name one repo", { writes: ["a/x.ts"], reads: [] }, "github.com/acme/a", "files"],
    ["edits outrank reads in another repo", { writes: ["a/x.ts"], reads: ["b/y.ts", "b/z.ts"] }, "github.com/acme/a", "files"],
    ["reads alone name one repo", { writes: [], reads: ["b/y.ts"] }, "github.com/acme/b", "files"],
    ["a Bash-only turn (reads of a directory)", { writes: [], reads: ["b"] }, "github.com/acme/b", "files"],
    ["edits in two repos: the majority, never a split", { writes: ["a/x.ts", "b/y.ts", "b/z.ts"], reads: [] }, "github.com/acme/b", "files"],
    ["paths outside any repo are not evidence", { writes: ["nowhere/x.ts"], reads: [] }, "dir:", "folder"],
    ["no evidence, no history: the folder", { writes: [], reads: [] }, "dir:", "folder"],
  ])("session in the parent folder, %s", async (_, rel, key, placement) => {
    const { ws, placer } = await world();
    const abs = (p: string) => join(ws, p);
    const e = ev({ cwd: ws, turn: "t1", touched: { writes: rel.writes.map(abs), reads: rel.reads.map(abs) } });
    await placer.place([e]);
    expect(e.metadata.repo?.key.startsWith(key)).toBe(true);
    expect(e.metadata.placement).toBe(placement);
  });

  it("a turn is placed as one: its first request (no tool call yet) gets the turn's repo, not the previous turn's", async () => {
    const { ws, a, b, placer } = await world();
    const t1 = [ev({ cwd: ws, turn: "t1", at: 1 }), ev({ cwd: ws, turn: "t1", at: 2, touched: { writes: [join(a, "x.ts")] } })];
    const t2 = [ev({ cwd: ws, turn: "t2", at: 3 }), ev({ cwd: ws, turn: "t2", at: 4, touched: { writes: [join(b, "y.ts")] } })];
    const t3 = [ev({ cwd: ws, turn: "t3", at: 5 })]; // text only: sticky to b
    await placer.place([...t3, ...t2, ...t1]); // arrival order must not matter
    expect(t1.map(placed)).toEqual([["github.com/acme/a", "files"], ["github.com/acme/a", "files"]]);
    expect(t2.map(placed)).toEqual([["github.com/acme/b", "files"], ["github.com/acme/b", "files"]]);
    expect(t3.map(placed)).toEqual([["github.com/acme/b", "sticky"]]);
  });

  it("sticky follows the session in time order and never crosses sessions", async () => {
    const { ws, a, placer } = await world();
    const s1 = [ev({ cwd: ws, sessionId: "s1", turn: "t1", at: 1, touched: { writes: [join(a, "x.ts")] } }), ev({ cwd: ws, sessionId: "s1", turn: "t2", at: 2 })];
    const s2 = [ev({ cwd: ws, sessionId: "s2", turn: "t1", at: 3 })];
    await placer.place([...s1, ...s2]);
    expect(placed(s1[1])).toEqual(["github.com/acme/a", "sticky"]);
    expect(s2[0].metadata.placement).toBe("folder");
  });

  it("a deleted worktree's files still place through the roots the hook recorded", async () => {
    const { ws, a, placer, sidecar } = await world();
    const wt = await fx.worktree(a, "ws/a-wt", "wt");
    await appendSidecar({ v: 1, ts: new Date().toISOString(), surface: "claude-code", sessionId: "s", cwd: ws, repo: null, root: null, branch: null, head: null, offset: 0, roots: { [wt]: { key: "github.com/acme/a", label: "a-wt", source: "remote" } } }, sidecar);
    await fx.git(a, "worktree", "remove", "--force", wt);
    const e = ev({ cwd: ws, turn: "t1", touched: { writes: [join(wt, "x.ts")] } });
    const fresh = new Placer(await IdentityResolver.create("install", sidecar));
    await fresh.place([e]);
    expect(e.metadata.repo).toEqual({ key: "github.com/acme/a", label: "a-wt", source: "remote" });
    expect(e.metadata.placement).toBe("files");
    void placer;
  });

  it("a deleted parent folder with a sidecar line still places its turns by files, then folder", async () => {
    const { ws, a, sidecar } = await world();
    await appendSidecar({ v: 1, ts: new Date().toISOString(), surface: "claude-code", sessionId: "s", cwd: ws, repo: null, root: null, branch: null, head: null, offset: 0, roots: { [a]: { key: "github.com/acme/a", label: "a", source: "remote" } } }, sidecar);
    await rm(ws, { recursive: true });
    const byFiles = ev({ cwd: ws, turn: "t1", at: 1, touched: { writes: [join(a, "x.ts")] } });
    const nothing = ev({ cwd: ws, sessionId: "s9", turn: "t1", at: 2 });
    const placer = new Placer(await IdentityResolver.create("install", sidecar));
    await placer.place([byFiles, nothing]);
    expect(placed(byFiles)).toEqual(["github.com/acme/a", "files"]);
    expect(nothing.metadata.repo).toBeUndefined(); // no sidecar for s9, folder gone: the Inbox
  });

  // The most specific root wins, wherever the answer comes from: a turn
  // that edits only the submodule is the submodule's, whether or not an
  // earlier turn already resolved the superproject around it.
  it("a turn that edits only a submodule lands on the submodule, after a superproject turn as when placed alone", async () => {
    const { ws, a, sub, placer, sidecar } = await withSubmodule();
    const t1 = ev({ cwd: ws, turn: "t1", at: 1, touched: { writes: [join(a, "x.ts")] } });
    const t2 = ev({ cwd: ws, turn: "t2", at: 2, touched: { writes: [join(sub, "y.ts")] } });
    await placer.place([t1, t2]);
    const alone = ev({ cwd: ws, sessionId: "s2", turn: "t1", at: 3, touched: { writes: [join(sub, "y.ts")] } });
    await new Placer(await IdentityResolver.create("install", sidecar)).place([alone]);
    expect(placed(t1)).toEqual(["github.com/acme/a", "files"]);
    expect(placed(t2)).toEqual(["github.com/acme/lib", "files"]);
    expect(placed(alone)).toEqual(placed(t2));
  });

  it("a sidecar that recorded only the superproject (an older hook) still places a live submodule's files on the submodule", async () => {
    const { ws, a, sub, sidecar } = await withSubmodule();
    await appendSidecar({ v: 1, ts: new Date().toISOString(), surface: "claude-code", sessionId: "s", cwd: ws, repo: null, root: null, branch: null, head: null, offset: 0, roots: { [a]: { key: "github.com/acme/a", label: "a", source: "remote" } } }, sidecar);
    const e = ev({ cwd: ws, turn: "t1", touched: { writes: [join(sub, "y.ts")] } });
    await new Placer(await IdentityResolver.create("install", sidecar)).place([e]);
    expect(placed(e)).toEqual(["github.com/acme/lib", "files"]);
  });

  it("events without a session or turn are placed one by one, as before", async () => {
    const { ws, a, placer } = await world();
    const inRepo = ev({ cwd: a, sessionId: undefined as unknown as string });
    inRepo.metadata.sessionId = undefined;
    const inFolder = ev({ cwd: ws });
    inFolder.metadata.sessionId = undefined;
    inFolder.metadata.turn = undefined;
    await placer.place([inRepo, inFolder]);
    expect(placed(inRepo)).toEqual(["github.com/acme/a", "cwd"]);
    expect(inFolder.metadata.placement).toBe("folder");
  });

  it("a transcript that says HEAD takes the session's branch from the sidecar; a real branch name is kept", async () => {
    const { a, sidecar } = await world();
    await appendSidecar({ v: 1, ts: new Date().toISOString(), surface: "claude-code", sessionId: "s", cwd: a, repo: null, root: a, branch: "feat/x", head: null }, sidecar);
    const placer = new Placer(await IdentityResolver.create("install", sidecar));
    const detached = ev({ cwd: a, turn: "t1", at: 1 });
    detached.metadata.gitBranch = "HEAD";
    const missing = ev({ cwd: a, turn: "t1", at: 2 });
    const named = ev({ cwd: a, turn: "t1", at: 3 });
    named.metadata.gitBranch = "other";
    const noSidecar = ev({ cwd: a, sessionId: "s2", turn: "t1", at: 4 });
    noSidecar.metadata.gitBranch = "HEAD";
    await placer.place([detached, missing, named, noSidecar]);
    expect([detached, missing, named, noSidecar].map((e) => e.metadata.gitBranch)).toEqual(["feat/x", "feat/x", "other", "HEAD"]);
  });
});

