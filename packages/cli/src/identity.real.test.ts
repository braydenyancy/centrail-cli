// Repo identity against real repos. The whole point of the key is that it
// is identical across every checkout of a repo, so every case here builds
// at least two checkouts and compares.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readHeadState, repoIdentity } from "./identity.js";
import { scratch, type Scratch } from "./testing/git-fixture.js";

let fx: Scratch;
afterEach(async () => {
  await fx?.cleanup();
});

describe("repoIdentity", () => {
  it("sibling worktree, nested worktree and a second clone share one remote key", async () => {
    fx = await scratch();
    const repo = await fx.repo("repo", { remote: "git@github.com:Acme/Repo.git" });
    const sibling = await fx.worktree(repo, "repo-feature", "feature");
    const nested = await fx.worktree(repo, join(repo, ".worktrees", "wt2"), "wt2");
    const clone = join(fx.root, "clone");
    await fx.git(fx.root, "clone", "-q", repo, clone);
    // A clone from the host carries the host's URL; a clone of a local path
    // carries the path, which is not an identity (see the null cases).
    await fx.git(clone, "remote", "set-url", "origin", "https://github.com/Acme/Repo");

    const ids = await Promise.all([repo, sibling, nested, clone].map((d) => repoIdentity(d)));
    for (const id of ids) {
      expect(id).toMatchObject({ key: "github.com/acme/repo", source: "remote" });
    }
    expect(ids.map((i) => i!.label)).toEqual(["repo", "repo-feature", "wt2", "clone"]);
  });

  it("falls back to the root commit for a repo without a remote — same across worktrees", async () => {
    fx = await scratch();
    const repo = await fx.repo("local");
    const wt = await fx.worktree(repo, "local-wt", "wt");
    const root = (await fx.git(repo, "rev-list", "--max-parents=0", "HEAD")).trim();

    expect(await repoIdentity(repo)).toEqual({ key: `sha:${root}`, label: "local", source: "root" });
    expect((await repoIdentity(wt))!.key).toBe(`sha:${root}`);
  });

  it("is null for an empty repo with no remote", async () => {
    fx = await scratch();
    const repo = await fx.repo("empty", { empty: true });
    expect(await repoIdentity(repo)).toBeNull();
  });

  it("prefers the remote over the root sha once one is added", async () => {
    fx = await scratch();
    const repo = await fx.repo("later");
    expect((await repoIdentity(repo))!.source).toBe("root");
    await fx.git(repo, "remote", "add", "origin", "https://gitlab.com/g/later.git");
    expect((await repoIdentity(repo))!.key).toBe("gitlab.com/g/later");
  });

  it("readHeadState: branch name on a branch, null when detached", async () => {
    fx = await scratch();
    const repo = await fx.repo("h");
    const head = await fx.git(repo, "rev-parse", "HEAD");
    expect(await readHeadState(repo)).toEqual({ branch: "main", head });
    const detached = await fx.worktree(repo, "h-detached");
    expect(await readHeadState(detached)).toEqual({ branch: null, head });
  });
});
