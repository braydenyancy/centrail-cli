// The resolver over real folders: live checkouts, a worktree deleted after
// the hook wrote its sidecar line, a plain folder, and nothing at all.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedUsageEvent } from "@centrail/parsers";
import { afterEach, describe, expect, it } from "vitest";
import { IdentityResolver } from "./resolver.js";
import { appendSidecar } from "./sidecar.js";
import { scratch, type Scratch } from "./testing/git-fixture.js";

let fx: Scratch;
afterEach(async () => {
  await fx?.cleanup();
});

function event(cwd: string | undefined, sessionId: string): ParsedUsageEvent {
  return {
    externalId: `req_${sessionId}`,
    provider: "anthropic",
    model: "claude-opus-4-8",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    occurredAt: new Date("2026-06-01T00:00:00Z"),
    metadata: { cwd, sessionId },
  };
}

describe("IdentityResolver", () => {
  it("a deleted worktree resolves through the sidecar, and attributes via the live sibling", async () => {
    fx = await scratch();
    const repo = await fx.repo("repo", { remote: "https://github.com/acme/repo.git" });
    const wt = await fx.worktree(repo, "repo-wt", "wt");
    const sidecar = join(fx.root, "sessions.jsonl");
    // The hook fired while the worktree was alive…
    await appendSidecar(
      {
        v: 1,
        ts: new Date().toISOString(),
        surface: "claude-code",
        sessionId: "s-dead",
        cwd: wt,
        repo: { key: "github.com/acme/repo", label: "repo-wt", source: "remote" },
        root: wt,
        branch: "wt",
        head: null,
      },
      sidecar,
    );
    // …and Claude Code's worktree mode removed it before sync ran.
    await rm(wt, { recursive: true, force: true });

    const resolver = await IdentityResolver.create("install", sidecar);
    const dead = event(wt, "s-dead");
    const live = event(repo, "s-live");
    await resolver.stamp(dead);
    await resolver.stamp(live);

    expect(dead.metadata.repo?.key).toBe("github.com/acme/repo");
    expect(live.metadata.repo?.key).toBe("github.com/acme/repo");
    expect(await resolver.liveRootFor(dead)).toBeNull();
    expect(await resolver.liveRootFor(live)).toBe(repo);
  });

  it("a plain folder gets a keyed folder id; a vanished folder with no sidecar gets nothing", async () => {
    fx = await scratch();
    const plain = join(fx.root, "notes");
    await fx.git(fx.root, "init", "-q", "--template=", join(fx.root, "unrelated")); // a repo nearby must not leak
    await rm(plain, { recursive: true, force: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(plain);

    const resolver = await IdentityResolver.create("install", join(fx.root, "none.jsonl"));
    const folder = event(plain, "s-plain");
    const gone = event(join(fx.root, "gone"), "s-gone");
    await resolver.stamp(folder);
    await resolver.stamp(gone);

    expect(folder.metadata.repo).toMatchObject({ label: "notes", source: "folder" });
    expect(folder.metadata.repo?.key).toMatch(/^dir:/);
    expect(gone.metadata.repo).toBeUndefined();
  });

  it("an inherited GIT_DIR does not turn a plain folder into that repo", async () => {
    fx = await scratch();
    const repo = await fx.repo("repo", { remote: "https://github.com/acme/repo.git" });
    const plain = join(fx.root, "plain");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(plain);
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(repo, ".git");
    try {
      const resolver = await IdentityResolver.create("install", join(fx.root, "none.jsonl"));
      const e = event(plain, "s");
      await resolver.stamp(e);
      expect(e.metadata.repo?.source).toBe("folder");
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });

  it("a plain folder deleted after its hook line keeps its folder id — the sidecar proves it existed", async () => {
    fx = await scratch();
    const folder = join(fx.root, "notes");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(folder);
    const sidecar = join(fx.root, "sessions.jsonl");
    await appendSidecar({ v: 1, ts: new Date().toISOString(), surface: "claude-code", sessionId: "s-notes", cwd: folder, repo: null, root: null, branch: null, head: null }, sidecar);
    const live = await IdentityResolver.create("install-1", sidecar);
    const before = event(folder, "s-notes");
    await live.stamp(before);
    await rm(folder, { recursive: true });
    const dead = await IdentityResolver.create("install-1", sidecar);
    const after = event(folder, "s-notes");
    await dead.stamp(after);
    // The same dir: key before and after the folder vanished — a rule set
    // while it existed must keep matching.
    expect(before.metadata.repo).toMatchObject({ source: "folder" });
    expect(after.metadata.repo).toEqual(before.metadata.repo);
  });

  it("a session whose cwd is a subfolder of a live repo resolves to the repo, and the same key from any depth", async () => {
    fx = await scratch();
    const repo = await fx.repo("repo", { remote: "https://github.com/acme/repo.git" });
    const { mkdir } = await import("node:fs/promises");
    const deep = join(repo, "packages", "cli", "src");
    await mkdir(deep, { recursive: true });
    const r = await IdentityResolver.create("install-1", join(fx.root, "none.jsonl"));
    const top = event(repo, "a");
    const nested = event(deep, "b");
    await r.stamp(top);
    await r.stamp(nested);
    expect(nested.metadata.repo).toEqual(top.metadata.repo);
    expect(await r.liveRootFor(nested)).toBe(repo);
  });

  it.each([
    ["pruned from the main repo (git worktree prune while the folder stayed)", "prune"],
    ["whose main repo's worktree entry was deleted by hand", "rm-entry"],
  ])("a stale worktree folder %s still resolves to the main repo's identity, not an anonymous folder", async (_, how) => {
    fx = await scratch();
    const repo = await fx.repo("stale", { remote: "https://github.com/acme/stale.git" });
    const wt = await fx.worktree(repo, "stale-wt", "wt");
    const { rm, rename } = await import("node:fs/promises");
    if (how === "prune") {
      await rename(wt, `${wt}.away`); // prune only drops entries whose folder is missing
      await fx.git(repo, "worktree", "prune");
      await rename(`${wt}.away`, wt);
    } else {
      await rm(join(repo, ".git", "worktrees", "stale-wt"), { recursive: true, force: true });
    }
    const r = await IdentityResolver.create("install-1", join(fx.root, "none.jsonl"));
    const e = event(wt, "s-stale");
    await r.stamp(e);
    expect(e.metadata.repo).toMatchObject({ key: "github.com/acme/stale", label: "stale-wt", source: "remote" });
  });
});

