// Real-git tests. git.test.ts mocks child_process to test parsing; the bugs
// that matter here are in what git itself does with the environment and the
// tree, which no mock can show. Fixtures: ./testing/git-fixture.ts.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listRecentShas, readRepoCommits, resolveRepoRoot } from "./git.js";
import { repoIdentity } from "./identity.js";
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

// `--all` is every ref, and two kinds of ref hold commits that are nobody's
// work: a stash (its WIP and index commits, and with -u a ROOT commit of the
// untracked files) and notes. Neither may become a fate row, an attribution
// target or a repo's root.
describe("stash and notes are not history", () => {
  async function stashed(name: string, branch = "main") {
    const repo = join(fx.root, name);
    await mkdir(repo);
    await fx.git(repo, "init", "-q", "--template=", "-b", branch);
    await fx.commit(repo, "a.txt");
    const head = await fx.git(repo, "rev-parse", "HEAD");
    for (const n of [1, 2, 3]) {
      await writeFile(join(repo, "a.txt"), `wip ${n}\n`);
      await writeFile(join(repo, `untracked-${n}.txt`), `${n}\n`);
      await fx.git(repo, "stash", "push", "-q", "-u", "-m", `wip ${n}`);
    }
    await fx.git(repo, "notes", "add", "-m", "a note", "HEAD");
    return { repo, head };
  }

  it("a stash and a note are neither recent commits nor --all history", async () => {
    fx = await scratch();
    const { repo, head } = await stashed("repo");
    expect((await listRecentShas(repo, 100_000)).map((c) => c.sha)).toEqual([head]);
    expect((await readRepoCommits(repo, "--all")).map((c) => c.sha)).toEqual([head]);
  });

  it("a detached repo with no default branch keys by its own root, not a stash's untracked-files root", async () => {
    fx = await scratch();
    const { repo, head } = await stashed("detached", "trunk");
    await fx.git(repo, "checkout", "-q", "--detach");
    expect(await repoIdentity(repo)).toMatchObject({ key: `sha:${head}`, source: "root", root: head });
  });
});
