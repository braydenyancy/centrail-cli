import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { parseGitLogNumstat, type RepoCommit } from "@centrail/parsers";

const execFileAsync = promisify(execFile);

// Git honours GIT_DIR, GIT_WORK_TREE and friends OVER `-C <dir>`: with GIT_DIR
// exported, `git -C /not-a-repo rev-parse --show-toplevel` answers
// "/not-a-repo" instead of failing, and every session on that machine is
// attributed to whichever directory it happened to run in. Every git spawn
// therefore gets the environment with the repo-redirecting variables removed.
const GIT_REDIRECT_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
];

export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of GIT_REDIRECT_VARS) delete env[key];
  env.GIT_OPTIONAL_LOCKS = "0"; // read-only queries never take the index lock
  return env;
}

function exec(
  cmd: string,
  args: string[],
  opts: { maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(cmd, args, { ...opts, env: gitEnv() });
}

// Every git spawn in the CLI goes through here, so the GIT_DIR scrub above
// cannot be bypassed by a new caller.
export function gitExec(
  args: string[],
  opts: { maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return exec("git", args, opts);
}

// Resolve the git toplevel for a working dir. Returns null if not a repo.
export async function resolveRepoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function repoName(repoRoot: string): string {
  return basename(repoRoot);
}

// Commits reachable from `ref` with numstat — HEAD for a live checkout, a
// branch ref for a session whose own worktree is gone (branches outlive
// worktrees), or "--all" when nothing better is known. Empty for an empty
// repo or an unknown ref.
export async function readRepoCommits(repoRoot: string, ref = "HEAD"): Promise<RepoCommit[]> {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", repoRoot, "log", ref, "--numstat", "--pretty=format:%x1e%H%x1f%cI", "--"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return parseGitLogNumstat(stdout);
  } catch {
    return [];
  }
}

// ---- Ship-status fact gathering -------------------------------------------
// These helpers only GATHER facts for the fate pass; every fate decision
// lives in @centrail/parsers (ship-status.ts). All of them are best-effort:
// any git failure degrades to null/[]/false so the fate pass can never brick
// a sync.

const FACT_BUFFER = 16 * 1024 * 1024;
export const RECENT_SHA_CAP = 2000;

// Default branch: `symbolic-ref refs/remotes/origin/HEAD` → main/master →
// current branch; each candidate must verify as a local head. Null when
// nothing resolves — callers skip the fate pass rather than guess.
export async function resolveDefaultBranch(repoRoot: string): Promise<string | null> {
  const candidates: string[] = [];
  try {
    const { stdout } = await exec("git", [
      "-C", repoRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD",
    ]);
    const short = stdout.trim(); // e.g. "origin/main"
    if (short) candidates.push(short.replace(/^origin\//, ""));
  } catch {
    // no origin HEAD (local-only repo) — fall through
  }
  candidates.push("main", "master");
  try {
    const { stdout } = await exec("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
    const current = stdout.trim();
    if (current && current !== "HEAD") candidates.push(current); // "HEAD" = detached
  } catch {
    // unreadable HEAD — fall through
  }
  for (const candidate of candidates) {
    try {
      await exec("git", [
        "-C", repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`,
      ]);
      return candidate;
    } catch {
      // candidate has no local head — try the next
    }
  }
  return null;
}

// Recent commits across ALL refs — shas + committer dates only, newest first,
// capped so a monorepo can't flood the fate pass.
export async function listRecentShas(
  repoRoot: string,
  sinceDays = 90,
): Promise<{ sha: string; committedAt: string }[]> {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", repoRoot, "log", "--all", `--since=${sinceDays} days ago`, "--pretty=format:%H%x1f%cI"],
      { maxBuffer: FACT_BUFFER },
    );
    const out: { sha: string; committedAt: string }[] = [];
    for (const line of stdout.split("\n")) {
      if (out.length >= RECENT_SHA_CAP) break;
      const [sha, iso] = line.split("\x1f");
      if (!sha?.trim() || !iso?.trim()) continue;
      out.push({ sha: sha.trim(), committedAt: iso.trim() });
    }
    return out;
  } catch {
    return [];
  }
}

export type BranchTip = {
  ref: string; // full refname, unambiguous for rev-list
  name: string; // short name exactly as `git branch -a` prints it
  sha: string;
  tipDate: string | null; // committer date of the tip (ISO), null if unknown
};

// Every local and remote-tracking branch with its tip sha and date, in ONE
// spawn. Symrefs (origin/HEAD) are skipped, as is anything git would print as
// bare "origin". Replaces one `log -1` per branch. NOTE: for-each-ref spells a
// hex byte as `%1f`, unlike `git log --pretty`, which spells it `%x1f`.
export async function listBranchTips(repoRoot: string): Promise<BranchTip[]> {
  try {
    const { stdout } = await exec(
      "git",
      [
        "-C", repoRoot, "for-each-ref",
        "--format=%(refname)%1f%(refname:short)%1f%(objectname)%1f%(committerdate:iso-strict)%1f%(symref)",
        "refs/heads", "refs/remotes",
      ],
      { maxBuffer: FACT_BUFFER },
    );
    const out: BranchTip[] = [];
    for (const line of stdout.split("\n")) {
      const [ref, name, sha, date, symref] = line.split("\x1f");
      if (!ref?.trim() || !name?.trim() || !sha?.trim()) continue;
      if (symref?.trim()) continue;
      if (name === "origin" || name === "origin/HEAD") continue;
      out.push({ ref: ref.trim(), name: name.trim(), sha: sha.trim(), tipDate: date?.trim() || null });
    }
    return out;
  } catch {
    return [];
  }
}

export const REACHABLE_CAP = 50000;

// Shas reachable from `ref` and committed inside the window: one spawn per
// ref instead of one `branch --contains` / `merge-base` per sha. Same cutoff
// as listRecentShas so the two sets line up.
export async function listReachableShas(
  repoRoot: string,
  ref: string,
  sinceDays = 90,
): Promise<string[]> {
  try {
    const { stdout } = await exec(
      "git",
      [
        "-C", repoRoot, "rev-list", `--since=${sinceDays} days ago`,
        `--max-count=${REACHABLE_CAP}`, ref, "--",
      ],
      { maxBuffer: FACT_BUFFER },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((sha) => sha.length > 0);
  } catch {
    return [];
  }
}

// Shas on `tipRef` whose patch already exists on `defaultRef` — `git cherry`
// prints them as "- <sha>" (squash-merge detection).
export async function cherryEquivalentShas(
  repoRoot: string,
  defaultRef: string,
  tipRef: string,
): Promise<string[]> {
  try {
    const { stdout } = await exec("git", ["-C", repoRoot, "cherry", defaultRef, tipRef], {
      maxBuffer: FACT_BUFFER,
    });
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim())
      .filter((sha) => sha.length > 0);
  } catch {
    return [];
  }
}

// Best-effort repo size: tracked file count (cheap) + total LOC (guarded).
// totalLoc is null when the repo is large enough that reading every file would
// be wasteful — fileCount alone is still a useful size proxy.
const LOC_FILE_CAP = 5000;
const LOC_BYTES_CAP = 1024 * 1024; // skip files > 1MB

export async function readRepoSize(
  repoRoot: string,
): Promise<{ totalLoc: number | null; fileCount: number }> {
  let files: string[] = [];
  try {
    const { stdout } = await exec("git", ["-C", repoRoot, "ls-files"], {
      maxBuffer: 64 * 1024 * 1024,
    });
    files = stdout.split("\n").filter((f) => f.length > 0);
  } catch {
    return { totalLoc: null, fileCount: 0 };
  }

  const fileCount = files.length;
  if (fileCount > LOC_FILE_CAP) return { totalLoc: null, fileCount };

  let totalLoc = 0;
  for (const rel of files) {
    try {
      const content = await readFile(`${repoRoot}/${rel}`);
      if (content.byteLength > LOC_BYTES_CAP) continue;
      if (content.includes(0)) continue; // crude binary skip (NUL byte)
      totalLoc += content.toString("utf-8").split("\n").length;
    } catch {
      // file removed/unreadable since ls-files — ignore
    }
  }
  return { totalLoc, fileCount };
}
