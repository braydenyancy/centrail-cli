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
    // The root sha rides with the remote key (§ 3.10), the same everywhere:
    // it is what lets the server see one repo behind two keys after a rename.
    const root = (await fx.git(repo, "rev-list", "--max-parents=0", "HEAD")).trim();
    for (const id of ids) {
      expect(id).toMatchObject({ key: "github.com/acme/repo", source: "remote", root });
    }
    expect(ids.map((i) => i!.label)).toEqual(["repo", "repo-feature", "wt2", "clone"]);
  });

  it("falls back to the root commit for a repo without a remote — same across worktrees", async () => {
    fx = await scratch();
    const repo = await fx.repo("local");
    const wt = await fx.worktree(repo, "local-wt", "wt");
    const root = (await fx.git(repo, "rev-list", "--max-parents=0", "HEAD")).trim();

    expect(await repoIdentity(repo)).toEqual({ key: `sha:${root}`, label: "local", source: "root", root });
    expect((await repoIdentity(wt))!.key).toBe(`sha:${root}`);
  });

  it("a clone of a laptop's repo over ssh keys by its root sha: no hostname, no home path", async () => {
    fx = await scratch();
    const repo = await fx.repo("acme-secret", { remote: "alice-macbook.local:/Users/alice/src/acme-secret.git" });
    const root = (await fx.git(repo, "rev-list", "--max-parents=0", "HEAD")).trim();
    const id = await repoIdentity(repo);
    expect(id).toEqual({ key: `sha:${root}`, label: "acme-secret", source: "root", root });
    expect(JSON.stringify(id)).not.toMatch(/alice|macbook/);
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

  it("a single-branch clone of a remote-less repo with an orphan branch shares the key", async () => {
    // `rev-list --max-parents=0 --all` sees every root a checkout HAS; a
    // clone that never fetched the orphan branch sees one fewer. The key
    // must not depend on which roots a checkout happens to hold, so it is
    // the default branch's root, and `--all` only when there is no default.
    fx = await scratch();
    const repo = await fx.repo("multi");
    const mainRoot = await fx.git(repo, "rev-parse", "HEAD");
    // Force the orphan root to sort BEFORE main's, so a min-over-all picks it.
    let orphanRoot = "";
    for (let i = 0; i < 64 && !(orphanRoot && orphanRoot < mainRoot); i++) {
      if (orphanRoot) {
        await fx.git(repo, "checkout", "-q", "main");
        await fx.git(repo, "branch", "-D", "pages");
      }
      await fx.git(repo, "checkout", "-q", "--orphan", "pages");
      await fx.git(repo, "rm", "-rfq", ".");
      orphanRoot = await fx.commit(repo, "index.html", `<p>${i}</p>\n`);
    }
    expect(orphanRoot < mainRoot).toBe(true);
    await fx.git(repo, "checkout", "-q", "main");
    const clone = join(fx.root, "multi-clone");
    await fx.git(fx.root, "clone", "-q", "--single-branch", "--branch", "main", repo, clone);
    expect(await fx.git(clone, "rev-list", "--max-parents=0", "--all")).toBe(mainRoot);

    expect((await repoIdentity(clone))!.key).toBe(`sha:${mainRoot}`);
    expect((await repoIdentity(repo))!.key).toBe(`sha:${mainRoot}`);
    // And a worktree of the full repo that has the orphan branch checked out.
    const wt = await fx.worktree(repo, "multi-pages", "pages-wt");
    await fx.git(wt, "checkout", "-q", "pages");
    expect((await repoIdentity(wt))!.key).toBe(`sha:${mainRoot}`);
  });

  it("a repo checked out AT the home directory labels as ~, not the username", async () => {
    fx = await scratch();
    const fakeHome = join(fx.root, "jane");
    await fx.repo("jane", { remote: "https://github.com/jane/dotfiles" });
    const prev = [process.env.HOME, process.env.USERPROFILE];
    process.env.HOME = process.env.USERPROFILE = fakeHome; // homedir() reads USERPROFILE on Windows
    try {
      expect(await repoIdentity(fakeHome)).toEqual({ key: "github.com/jane/dotfiles", label: "~", source: "remote", root: expect.stringMatching(/^[0-9a-f]{40}$/) });
    } finally {
      [process.env.HOME, process.env.USERPROFILE] = prev;
    }
  });
});
