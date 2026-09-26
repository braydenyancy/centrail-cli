// Real-git tests. git.test.ts mocks child_process to test parsing; the bugs
// that matter here are in what git itself does with the environment and the
// tree, which no mock can show. Fixtures: ./testing/git-fixture.ts.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRepoCommits, resolveRepoRoot } from "./git.js";
import { scratch, type Scratch } from "./testing/git-fixture.js";

let fx: Scratch;
const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
afterEach(async () => {
  for (const k of ["GIT_DIR", "GIT_WORK_TREE"] as const) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await fx?.cleanup();
});

describe("resolveRepoRoot against real repos", () => {
  it("resolves the toplevel of a repo and null for a plain directory", async () => {
    fx = await scratch();
    const repo = await fx.repo("repo");
    const plain = join(fx.root, "plain");
    await mkdir(plain);

    expect(await resolveRepoRoot(repo)).toBe(repo);
    expect(await resolveRepoRoot(plain)).toBeNull();
    expect(await readRepoCommits(repo)).toHaveLength(1);
  });

  it("ignores an inherited GIT_DIR — the verified mis-attribution", async () => {
    fx = await scratch();
    const repo = await fx.repo("repo");
    const plain = join(fx.root, "plain");
    await mkdir(plain);

    // With GIT_DIR exported, plain `git -C plain rev-parse --show-toplevel`
    // answers `plain` (exit 0). The CLI must not: a directory that is not a
    // repo stays not a repo whatever the shell exported.
    process.env.GIT_DIR = join(repo, ".git");
    process.env.GIT_WORK_TREE = repo;

    expect(await resolveRepoRoot(plain)).toBeNull();
    expect(await resolveRepoRoot(repo)).toBe(repo);
  });

  it("resolves a sibling worktree to its own toplevel (the .git FILE case)", async () => {
    fx = await scratch();
    const repo = await fx.repo("repo");
    const wt = await fx.worktree(repo, "repo-feature", "feature");

    expect(await resolveRepoRoot(wt)).toBe(wt);
    expect(await readRepoCommits(wt)).toHaveLength(1);
  });

  it("resolves a worktree nested inside the checkout to the worktree, not the parent", async () => {
    fx = await scratch();
    const repo = await fx.repo("repo");
    const nested = await fx.worktree(repo, join(repo, ".worktrees", "wt"), "wt");

    expect(await resolveRepoRoot(nested)).toBe(nested);
    expect(await resolveRepoRoot(join(nested, "sub"))).toBeNull(); // does not exist
  });

});

describe("squashedShas against real repos", () => {
  it("maps every commit of a squash-merged branch to the squash commit; an unmerged branch maps nothing; commits after the squash stay unmapped", async () => {
    const { squashedShas } = await import("./git.js");
    const { writeFile } = await import("node:fs/promises");
    fx = await scratch();
    const repo = await fx.repo("sq");
    const commit = async (file: string) => {
      await writeFile(join(repo, file), `${file}\n`);
      await fx.git(repo, "add", file);
      await fx.git(repo, "commit", "-q", "-m", file);
      return fx.git(repo, "rev-parse", "HEAD");
    };
    await fx.git(repo, "checkout", "-q", "-b", "feat");
    const b1 = await commit("f1");
    const b2 = await commit("f2");
    await fx.git(repo, "checkout", "-q", "main");
    await fx.git(repo, "merge", "--squash", "-q", "feat");
    await fx.git(repo, "commit", "-q", "-m", "feat squashed");
    const squash = await fx.git(repo, "rev-parse", "HEAD");
    await commit("unrelated"); // main moves on
    await fx.git(repo, "checkout", "-q", "feat");
    const b3 = await commit("f3"); // work after the squash, not merged
    await fx.git(repo, "checkout", "-q", "-b", "other", "main");
    await commit("o1");
    expect(await squashedShas(repo, "refs/heads/main", "refs/heads/feat")).toEqual({ [b1]: squash, [b2]: squash });
    expect(await squashedShas(repo, "refs/heads/main", "refs/heads/other")).toEqual({});
    expect(b3).not.toBe(squash);
  });
});

