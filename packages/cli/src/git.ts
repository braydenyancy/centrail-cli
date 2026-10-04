import { execFile, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
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

// The repo root for a path that may not exist (a file the turn created in
// a new directory, a Bash argument, a worktree since deleted): climb to
// the nearest existing ancestor and ask git there. Null past the top.
export async function resolveRepoRootNear(path: string): Promise<string | null> {
  const dir = await nearestDirectory(path);
  return dir ? resolveRepoRoot(dir) : null;
}

// The closest existing directory at or above a path; null past the top.
export async function nearestDirectory(path: string): Promise<string | null> {
  let dir = path;
  for (;;) {
    try {
      if ((await stat(dir)).isDirectory()) return dir;
    } catch {
      // missing: climb
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The main checkout of a linked worktree — the folder whose `.git` holds the
// common dir — or null for a main checkout or a bare repo. Branches and
// commits outlive worktrees; this path is how a dead worktree's events
// still find its history when no session ever ran in the main checkout.
export async function readMainCheckout(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const common = stdout.trim();
    if (!common || basename(common) !== ".git") return null;
    const main = dirname(common);
    return main === repoRoot ? null : main;
  } catch {
    return null;
  }
}

export function repoName(repoRoot: string): string {
  return basename(repoRoot);
}

// "--all" as every ref that holds work. A stash's commits (WIP, index, and
// with -u a root commit of the untracked files) and notes commits are
// nobody's work: as fate rows, attribution targets or a repo's root they
// would be wrong. An --exclude applies to the --all after it, so order
// matters.
export function revRange(ref: string): string[] {
  return ref === "--all" ? ["--exclude=refs/stash", "--exclude=refs/notes/*", "--all"] : [ref];
}

// Commits reachable from `ref` with numstat — HEAD for a live checkout, a
// branch ref for a session whose own worktree is gone (branches outlive
// worktrees), or "--all" when nothing better is known. Empty for an empty
// repo or an unknown ref.
export async function readRepoCommits(repoRoot: string, ref = "HEAD"): Promise<RepoCommit[]> {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", repoRoot, "log", ...revRange(ref), "--numstat", "--pretty=format:%x1e%H%x1f%cI", "--"],
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

// The ref "shipped" is judged against: the remote's default branch when
// the checkout tracks one, else the local head. A worktree parked detached
// at origin/main never fast-forwards its local main (the canonical clone
// holds it), so the local head is stale by design there.
export async function resolveAncestryRef(repoRoot: string, defaultBranch: string): Promise<string> {
  const remote = `refs/remotes/origin/${defaultBranch}`;
  try {
    await exec("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", remote]);
    return remote;
  } catch {
    return `refs/heads/${defaultBranch}`;
  }
}

const SQUASH_CANDIDATE_CAP = 200;
const SQUASH_PREFIX_CAP = 50;

// A squash merge leaves the branch's commits off the default branch with
// no ancestor there, and `git cherry` compares one commit at a time, so a
// multi-commit branch never matches. The branch's patch since its merge
// base does: compare the patch-id of each PREFIX of the branch (work may
// have continued on it after the merge) with each default-branch commit
// committed since the branch began. The commits of the matching prefix map
// to that squash commit. Empty when nothing matches, the branch is already
// merged, or git fails. Bounded: 50 prefixes, 200 candidates.
export async function squashedShas(repoRoot: string, defaultRef: string, tipRef: string): Promise<Record<string, string>> {
  try {
    const { stdout: baseOut } = await exec("git", ["-C", repoRoot, "merge-base", defaultRef, tipRef]);
    const base = baseOut.trim();
    if (!base) return {};
    const { stdout: branchOut } = await exec("git", ["-C", repoRoot, "rev-list", "--reverse", `--max-count=${SQUASH_PREFIX_CAP}`, "--pretty=format:%H%x1f%cI", `${base}..${tipRef}`]);
    const branch = branchOut
      .split("\n")
      .filter((l) => !l.startsWith("commit ") && l.includes("\x1f"))
      .map((l) => l.split("\x1f"))
      .map(([sha, iso]) => ({ sha: sha.trim(), at: iso.trim() }));
    if (branch.length === 0) return {};
    // A squash commit postdates the work it squashes.
    const { stdout: candOut } = await exec("git", ["-C", repoRoot, "rev-list", `--max-count=${SQUASH_CANDIDATE_CAP}`, `--since=${branch[0].at}`, `${base}..${defaultRef}`]);
    const candidates = candOut.split("\n").map((l) => l.trim()).filter(Boolean);
    if (candidates.length === 0) return {};
    const byPatchId = new Map<string, string>();
    for (const sha of candidates) {
      const { stdout: diff } = await exec("git", ["-C", repoRoot, "diff-tree", "-p", "--root", sha], { maxBuffer: FACT_BUFFER });
      const id = await patchId(repoRoot, diff);
      if (id && !byPatchId.has(id)) byPatchId.set(id, sha);
    }
    // Longest prefix first: a branch squashed twice maps to its latest squash.
    for (let k = branch.length; k >= 1; k--) {
      const { stdout: diff } = await exec("git", ["-C", repoRoot, "diff", base, branch[k - 1].sha], { maxBuffer: FACT_BUFFER });
      if (!diff.trim()) continue;
      const id = await patchId(repoRoot, diff);
      const into = id ? byPatchId.get(id) : undefined;
      if (!into) continue;
      const out: Record<string, string> = {};
      for (const b of branch.slice(0, k)) out[b.sha] = into;
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

// `git patch-id --stable` over a diff on stdin: the content hash of a
// change, independent of sha, date, message and whitespace context.
function patchId(repoRoot: string, diff: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", repoRoot, "patch-id", "--stable"], { env: gitEnv() });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(out.trim().split(/\s+/)[0] || null));
    child.stdin.end(diff);
  });
}

// Recent commits across every work ref (revRange) with their facts — sha, committer date,
// line counts — newest first, in ONE spawn, capped so a monorepo can't
// flood the fate pass. The facts ride every fate row (§ 3.8) so the server
// can match events to commits without a window, on any machine.
export type RecentCommit = {
  sha: string;
  committedAt: string; // ISO
  linesAdded: number;
  linesDeleted: number;
  filesChanged: number;
  authorEmail?: string; // compared to user.email locally; never on the wire
};

export async function listRecentShas(repoRoot: string, sinceDays = 90): Promise<RecentCommit[]> {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", repoRoot, "log", ...revRange("--all"), `--since=${sinceDays} days ago`, "--numstat", "--pretty=format:%x1e%H%x1f%cI%x1f%ae"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return parseGitLogNumstat(stdout)
      .slice(0, RECENT_SHA_CAP)
      .map((c) => ({
        sha: c.sha,
        committedAt: c.committedAt.toISOString(),
        linesAdded: c.linesAdded,
        linesDeleted: c.linesDeleted,
        filesChanged: c.filesChanged,
        ...(c.authorEmail ? { authorEmail: c.authorEmail } : {}),
      }));
  } catch {
    return [];
  }
}

// This checkout's git identity, lowercased, for the `mine` flag on fate
// rows. Null when unset; the address itself never leaves the machine.
export async function readUserEmail(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", repoRoot, "config", "user.email"]);
    const email = stdout.trim().toLowerCase();
    return email || null;
  } catch {
    return null;
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
