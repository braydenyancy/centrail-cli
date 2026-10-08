// Real-git fixtures for tests. A spawned `git` reads the real disk, so no
// in-memory filesystem can stand in; instead every fixture is a real repo in
// a temp dir OUTSIDE this checkout, built with a hermetic environment. The
// bugs worth testing here are what git does with the environment and the
// tree — worktrees, GIT_DIR, deleted folders — which no mock can show.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gitEnv } from "../git.js";

const run = promisify(execFile);

// No user or system config, fixed identity and dates, no ambient GIT_DIR
// (the thing under test), and a ceiling so discovery can never walk up out
// of the scratch dir into this checkout.
export function fixtureEnv(scratchRoot: string): NodeJS.ProcessEnv {
  return {
    ...gitEnv(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CEILING_DIRECTORIES: dirname(scratchRoot),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_AUTHOR_DATE: "2026-06-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-06-01T00:00:00Z",
    TZ: "UTC",
    LC_ALL: "C",
  };
}

export type Scratch = {
  root: string;
  git: (cwd: string, ...args: string[]) => Promise<string>;
  // A repo with one commit on `main`, no remote unless `remote` is given.
  repo: (name: string, opts?: { remote?: string; empty?: boolean }) => Promise<string>;
  // `git worktree add` at `path` (absolute or relative to root) on a new branch.
  worktree: (repo: string, path: string, branch?: string) => Promise<string>;
  commit: (cwd: string, file: string, content?: string, at?: Date) => Promise<string>;
  cleanup: () => Promise<void>;
};

// realpath: macOS hands out /var/folders/… while git answers /private/var/…,
// and Windows a short RUNNER~1 that git answers long; .native expands both.
export async function scratch(): Promise<Scratch> {
  const root = await mkdtemp(join(realpathSync.native(tmpdir()), "centrail-git-"));
  const env = fixtureEnv(root);
  const git = async (cwd: string, ...args: string[]): Promise<string> => {
    const { stdout } = await run("git", ["-C", cwd, ...args], { env });
    return stdout.trim();
  };
  // `at` overrides the pinned 2026-06-01 commit date, for tests that need a
  // commit AFTER an event stamped near the wall clock.
  const commit = async (cwd: string, file: string, content = `${file}\n`, at?: Date): Promise<string> => {
    await writeFile(join(cwd, file), content);
    await git(cwd, "add", file);
    if (at) {
      const dated = { ...env, GIT_AUTHOR_DATE: at.toISOString(), GIT_COMMITTER_DATE: at.toISOString() };
      await run("git", ["-C", cwd, "commit", "-q", "-m", file], { env: dated });
    } else {
      await git(cwd, "commit", "-q", "-m", file);
    }
    return git(cwd, "rev-parse", "HEAD");
  };
  const repo = async (name: string, opts: { remote?: string; empty?: boolean } = {}): Promise<string> => {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await git(dir, "init", "-q", "--template=", "-b", "main");
    if (opts.remote) await git(dir, "remote", "add", "origin", opts.remote);
    if (!opts.empty) await commit(dir, "a.txt");
    return dir;
  };
  const worktree = async (repoDir: string, path: string, branch?: string): Promise<string> => {
    const abs = path.startsWith("/") ? path : join(root, path);
    const args = ["worktree", "add", "-q"];
    if (branch) args.push("-b", branch);
    args.push(abs);
    if (!branch) args.push("HEAD", "--detach");
    await git(repoDir, ...args);
    return abs;
  };
  const cleanup = async (): Promise<void> => {
    await rm(root, { recursive: true, force: true });
  };
  return { root, git, repo, worktree, commit, cleanup };
}
