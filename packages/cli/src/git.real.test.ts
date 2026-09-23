// Real-git tests. git.test.ts mocks child_process to test parsing; the bugs
// that matter here are in what git itself does with the environment and the
// tree, which no mock can show. Every repo is built in a temp dir OUTSIDE
// this checkout, so "not a repo" cannot resolve to centrail-cli by accident.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { gitEnv, readRepoCommits, resolveRepoRoot } from "./git.js";

const run = promisify(execFile);

// A hermetic env for the fixture's own git calls: no user or system config,
// fixed identity and dates, and no ambient GIT_DIR — the thing under test.
const FIXTURE_ENV: NodeJS.ProcessEnv = {
  ...gitEnv(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_AUTHOR_DATE: "2026-06-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-06-01T00:00:00Z",
  TZ: "UTC",
  LC_ALL: "C",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], { env: FIXTURE_ENV });
  return stdout.trim();
}

// realpath: macOS hands out /var/folders/… while git answers /private/var/….
async function scratch(): Promise<string> {
  return mkdtemp(join(realpathSync(tmpdir()), "centrail-git-"));
}

async function repoWithOneCommit(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "--template=", "-b", "main");
  await writeFile(join(dir, "a.txt"), "a\n");
  await git(dir, "add", "a.txt");
  await git(dir, "commit", "-q", "-m", "one");
}

const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
afterEach(() => {
  for (const k of ["GIT_DIR", "GIT_WORK_TREE"] as const) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveRepoRoot against real repos", () => {
  it("resolves the toplevel of a repo and null for a plain directory", async () => {
    const base = await scratch();
    const repo = join(base, "repo");
    const plain = join(base, "plain");
    await repoWithOneCommit(repo);
    await mkdir(plain);

    expect(await resolveRepoRoot(repo)).toBe(repo);
    expect(await resolveRepoRoot(plain)).toBeNull();
    expect(await readRepoCommits(repo)).toHaveLength(1);
  });

  it("ignores an inherited GIT_DIR — the verified mis-attribution", async () => {
    const base = await scratch();
    const repo = join(base, "repo");
    const plain = join(base, "plain");
    await repoWithOneCommit(repo);
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
    const base = await scratch();
    const repo = join(base, "repo");
    const wt = join(base, "repo-feature");
    await repoWithOneCommit(repo);
    await git(repo, "worktree", "add", "-q", "-b", "feature", wt);

    expect(await resolveRepoRoot(wt)).toBe(wt);
    expect(await readRepoCommits(wt)).toHaveLength(1);
  });
});
