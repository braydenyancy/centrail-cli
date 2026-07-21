import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { parseGitLogNumstat, type RepoCommit } from "@centrail/parsers";

const exec = promisify(execFile);

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

// All commits in the repo with numstat. Empty array for an empty repo.
export async function readRepoCommits(repoRoot: string): Promise<RepoCommit[]> {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", repoRoot, "log", "--numstat", "--pretty=format:%x1e%H%x1f%cI"],
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

// True iff `sha` is an ancestor of `ref` (exit code 0). Any failure — not an
// ancestor (exit 1), unknown ref, missing repo — is false.
export async function isAncestor(repoRoot: string, sha: string, ref: string): Promise<boolean> {
  try {
    await exec("git", ["-C", repoRoot, "merge-base", "--is-ancestor", sha, ref]);
    return true;
  } catch {
    return false;
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

// Local + remote branch short names containing `sha`. Filters git's noise
// lines: detached-HEAD "(...)" and the origin/HEAD symref (which
// %(refname:short) renders as bare "origin").
export async function branchesContaining(repoRoot: string, sha: string): Promise<string[]> {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", repoRoot, "branch", "-a", "--format=%(refname:short)", "--contains", sha],
      { maxBuffer: FACT_BUFFER },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (b) => b.length > 0 && !b.startsWith("(") && b !== "origin" && b !== "origin/HEAD",
      );
  } catch {
    return [];
  }
}

// Committer date (ISO) of a branch tip, or null when the ref is unknown.
export async function branchTipDate(repoRoot: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", repoRoot, "log", "-1", "--pretty=%cI", ref]);
    return stdout.trim() || null;
  } catch {
    return null;
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
