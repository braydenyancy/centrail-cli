import { createHmac } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { RepoIdentity } from "@centrail/parsers";
import { gitExec, resolveDefaultBranch } from "./git.js";

// Repo identity: the one string that is the same for every checkout of a
// repo — every worktree, every clone, every machine, every user on a team.
// The folder basename (0.5.x) was none of those: four worktrees of one repo
// became four repos, two repos named `api` became one, and a checkout that
// was deleted before sync took its identity with it.
//
//   key     `github.com/owner/repo` — the canonical remote, or `sha:<root>`
//           when the repo has no remote, or `dir:<hmac>` for a folder that
//           is not a repo at all.
//   label   what a human sees: the folder basename. Never used as a key.
//   source  how the key was derived, so the server can rank confidence.
//
// The remote wins over the root sha because a root sha changes on history
// rewrite and is invisible to procurement, while `owner/repo` is what the
// GitHub App install already disclosed (LinearB, Swarmia, Sentry all key on
// it in plaintext). See docs/decisions/2026-09-system-audit.md § 3.1.

// Canonical key for a remote URL, or null when the remote does not name a
// hosted repo (a local path, `file://`, or garbage). Every form of the same
// repo — https with credentials, scp-like ssh, `ssh://` with a port, Azure's
// ssh vs https shapes — folds to one lowercase `host/path` with `.git`
// stripped. Lowercase because GitHub, GitLab, Bitbucket and Azure DevOps all
// treat owner/repo case-insensitively.
export function remoteKey(url: string): string | null {
  const raw = url.trim();
  if (!raw) return null;

  let host: string;
  let path: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if (proto === "file") return null;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    host = u.hostname;
    path = u.pathname;
  } else {
    // scp-like: [user@]host:path — but not a local path, which has a slash
    // before any colon (or no colon at all), and not a Windows drive
    // (`C:\code\repo`), whose "host" is one letter.
    const m = /^(?:[^@/]+@)?([^:/\\]{2,}):([^\\]+)$/.exec(raw);
    if (!m) return null;
    host = m[1];
    path = m[2];
  }
  host = host.toLowerCase();
  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!host || !path || host === "localhost") return null;

  // Azure DevOps: ssh `ssh.dev.azure.com:v3/org/project/repo` and https
  // `dev.azure.com/org/project/_git/repo` are one repo. Fold ssh into the
  // https shape, which is also the URL a human sees in the browser.
  if (host === "ssh.dev.azure.com") {
    const m = /^v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    if (!m) return null;
    host = "dev.azure.com";
    path = `${m[1]}/${m[2]}/_git/${m[3]}`;
  } else if (host === "vs-ssh.visualstudio.com") {
    const m = /^v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    if (!m) return null;
    host = `${m[1].toLowerCase()}.visualstudio.com`;
    path = `${m[2]}/_git/${m[3]}`;
  } else if (host.endsWith(".visualstudio.com")) {
    path = path.replace(/^defaultcollection\//i, "");
  }

  const key = `${host}/${path}`.toLowerCase();
  return /^[a-z0-9.-]+\/[^\s]+$/.test(key) ? key : null;
}

// The repo's remote key: `origin` when it has one, else the first remote.
async function readRemoteKey(repoRoot: string): Promise<string | null> {
  let url: string | null = null;
  try {
    const { stdout } = await gitExec(["-C", repoRoot, "remote", "get-url", "origin"]);
    url = stdout.trim() || null;
  } catch {
    // no origin — fall through to the first remote, if any
  }
  if (!url) {
    try {
      const { stdout } = await gitExec(["-C", repoRoot, "remote"]);
      const first = stdout.split("\n").map((s) => s.trim()).find((s) => s.length > 0);
      if (first) {
        const r = await gitExec(["-C", repoRoot, "remote", "get-url", first]);
        url = r.stdout.trim() || null;
      }
    } catch {
      // no remotes at all
    }
  }
  return url ? remoteKey(url) : null;
}

// The root commit is the same object in every worktree and clone, and the
// only durable identity a remote-less repo has. Which root, when a repo has
// several (orphan branches): the default branch's, because that is the one
// every clone fetched — `--all` sees whatever roots THIS checkout happens
// to hold, and a `--single-branch` clone holds fewer. `--all` only when no
// default branch resolves; the smallest sha keeps either answer
// deterministic.
async function readRootSha(repoRoot: string): Promise<string | null> {
  const branch = await resolveDefaultBranch(repoRoot);
  const roots = await listRoots(repoRoot, branch ? `refs/heads/${branch}` : "--all");
  return roots[0] ?? null;
}

async function listRoots(repoRoot: string, ref: string): Promise<string[]> {
  try {
    const { stdout } = await gitExec(["-C", repoRoot, "rev-list", "--max-parents=0", ref]);
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => /^[0-9a-f]{40,64}$/.test(s))
      .sort();
  } catch {
    return [];
  }
}

// What a human sees for a path: its basename — except the home directory
// itself, whose basename IS the username. A session in `~` or a dotfiles
// repo checked out at `~` would otherwise put the login on the wire, the
// one thing the folder key exists to keep off it.
export function displayLabel(path: string): string {
  const p = path.replace(/[\/\\]+$/, "");
  const home = homedir().replace(/[\/\\]+$/, "");
  if (p === home) return "~";
  try {
    if (realpathSync(p) === realpathSync(home)) return "~";
  } catch {
    // a path that no longer exists cannot be the home directory
  }
  return basename(p);
}

// Identity for a resolved repo root. Null only for a repo with neither a
// hosted remote nor a commit — callers treat that like a plain folder.
export async function repoIdentity(repoRoot: string): Promise<RepoIdentity | null> {
  const label = displayLabel(repoRoot);
  const remote = await readRemoteKey(repoRoot);
  if (remote) return { key: remote, label, source: "remote" };
  const root = await readRootSha(repoRoot);
  if (root) return { key: `sha:${root}`, label, source: "root" };
  return null;
}

// Identity for a folder that is not a repo: a keyed hash of its path, so the
// path itself (which discloses the username) never leaves the machine, yet
// every session in that folder groups under one id on this install. The key
// is this install's random id; there is nothing to reverse.
export function folderIdentity(cwd: string, installId: string): RepoIdentity {
  const digest = createHmac("sha256", installId).update(cwd).digest("hex").slice(0, 16);
  return { key: `dir:${digest}`, label: displayLabel(cwd), source: "folder" };
}

// Current branch (null when detached) and HEAD sha, for the sidecar.
export async function readHeadState(
  repoRoot: string,
): Promise<{ branch: string | null; head: string | null }> {
  let branch: string | null = null;
  let head: string | null = null;
  try {
    const { stdout } = await gitExec(["-C", repoRoot, "symbolic-ref", "--short", "-q", "HEAD"]);
    branch = stdout.trim() || null;
  } catch {
    // detached HEAD exits 1
  }
  try {
    const { stdout } = await gitExec(["-C", repoRoot, "rev-parse", "--verify", "-q", "HEAD"]);
    head = stdout.trim() || null;
  } catch {
    // unborn branch
  }
  return { branch, head };
}
