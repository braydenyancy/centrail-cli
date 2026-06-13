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
