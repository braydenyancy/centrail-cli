import { execFile, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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

// The longest of `roots` that `path` is at or under: the most specific
// checkout that may hold it. Null when none does.
export function deepestRoot(roots: Iterable<string>, path: string): string | null {
  let best: string | null = null;
  for (const r of roots) if ((path === r || path.startsWith(`${r}/`)) && (!best || r.length > best.length)) best = r;
  return best;
}

// Whether a checkout nested inside `root` holds `dir` — a submodule, a repo
// cloned inside another, a worktree placed inside its main checkout. Git's
// discovery stops at the first folder with a `.git` entry, so a known root
// answers for `dir` only when no folder below it on the way has one. Stats,
// never a spawn: this is what lets a known root stand in for git.
export async function nestedCheckout(root: string, dir: string): Promise<boolean> {
  for (let d = dir; d !== root && d.startsWith(`${root}/`); d = dirname(d)) {
    try {
      await stat(join(d, ".git"));
      return true;
    } catch {
      // no .git here: climb
    }
  }
  return false;
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

export const SQUASH_CANDIDATE_CAP = 200;
export const SQUASH_PREFIX_CAP = 50;

// One commit of a branch's unmerged range, with the merge base its prefix
// patch is taken from.
export type PrefixCommit = { sha: string; at: string; base: string };

// The newest SQUASH_PREFIX_CAP commits of `tipRef` not on the default
// branch, oldest first, each with the commit its cumulative patch starts
// from: its own merge base with `defaultRef`, which is what a squash of the
// branch up to that commit carries. One merge base serves the whole range
// unless the range holds a merge — a branch that merged the default branch
// in ("Update branch") moved its base, and the commits before that merge
// keep the older one, found per commit. Empty when the branch is merged,
// unrelated, or git fails.
export async function branchPrefixes(repoRoot: string, defaultRef: string, tipRef: string): Promise<PrefixCommit[]> {
  try {
    const mergeBase = async (ref: string) =>
      (await exec("git", ["-C", repoRoot, "merge-base", defaultRef, ref])).stdout.trim();
    const base = await mergeBase(tipRef);
    if (!base) return [];
    const { stdout } = await exec(
      "git",
      ["-C", repoRoot, "rev-list", "--reverse", `--max-count=${SQUASH_PREFIX_CAP}`, "--format=%H%x1f%cI%x1f%P", `${base}..${tipRef}`],
      { maxBuffer: FACT_BUFFER },
    );
    const range = stdout
      .split("\n")
      .filter((l) => l.includes("\x1f"))
      .map((l) => l.split("\x1f").map((x) => x.trim()))
      .map(([sha, at, parents]) => ({ sha, at, merge: parents.split(" ").length > 1 }));
    if (!range.some((c) => c.merge)) return range.map(({ sha, at }) => ({ sha, at, base }));
    // Only descendants of `base` share it; the rest predate the merge.
    const { stdout: pathOut } = await exec(
      "git",
      ["-C", repoRoot, "rev-list", "--ancestry-path", `${base}..${tipRef}`],
      { maxBuffer: FACT_BUFFER },
    );
    const onPath = new Set(pathOut.split("\n").map((l) => l.trim()).filter(Boolean));
    const out: PrefixCommit[] = [];
    for (const { sha, at } of range) {
      const own = onPath.has(sha) ? base : await mergeBase(sha);
      if (own) out.push({ sha, at, base: own });
    }
    return out;
  } catch {
    return [];
  }
}

// `git patch-id --stable` for many commits in TWO spawns, whatever the
// count: one `git diff-tree --stdin -p` streamed into one `git patch-id`.
// A bare sha is the commit's own diff against its parent; a root or merge
// commit prints no diff there, so it gets no id. `{ sha, base }` is the
// cumulative diff from `base` to `sha`. Keyed by sha, so one kind per call.
// The diff options are pinned, not read from config (renames, algorithm,
// path quoting): the server compares ids computed on different machines.
// A content hash: it says two changes are the same, never what they are.
// Empty on any failure.
export function patchIds(repoRoot: string, commits: { sha: string; base?: string }[]): Promise<Record<string, string>> {
  if (commits.length === 0) return Promise.resolve({});
  return new Promise((resolve) => {
    const opts = { env: gitEnv(), stdio: ["pipe", "pipe", "ignore"] as ["pipe", "pipe", "ignore"] };
    const diff = spawn(
      "git",
      ["-C", repoRoot, "-c", "core.quotePath=true", "diff-tree", "--stdin", "-p", "--no-renames", "--diff-algorithm=myers", "--indent-heuristic", "--no-ext-diff", "--no-textconv"],
      opts,
    );
    const ids = spawn("git", ["-C", repoRoot, "patch-id", "--stable"], opts);
    let text = "";
    let ok = true;
    let open = 2;
    const done = (code: number | null) => {
      if (code !== 0) ok = false;
      if (--open > 0) return;
      const out: Record<string, string> = {};
      if (ok) {
        for (const line of text.split("\n")) {
          const [id, sha] = line.trim().split(/\s+/);
          if (id && sha) out[sha] = id;
        }
      }
      resolve(out);
    };
    for (const child of [diff, ids]) {
      let settled = false; // a spawn failure emits "error", and may or may not emit "close"
      const settle = (code: number | null) => void (settled || ((settled = true), done(code)));
      child.on("error", () => settle(null));
      child.on("close", settle);
      child.stdin.on("error", () => (ok = false));
    }
    diff.stdout.pipe(ids.stdin);
    ids.stdout.on("data", (d) => (text += d));
    diff.stdin.end(commits.map((c) => (c.base ? `${c.sha} ${c.base}` : c.sha)).join("\n") + "\n");
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
