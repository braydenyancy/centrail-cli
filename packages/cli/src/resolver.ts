import { stat } from "node:fs/promises";
import type { ParsedUsageEvent, RepoIdentity } from "@centrail/parsers";
import { deepestRoot, nearestDirectory, nestedCheckout, resolveRepoRoot } from "./git.js";
import { folderIdentity, repoIdentity, staleWorktree } from "./identity.js";
import { basename } from "node:path";
import { readSidecar, type SidecarLine } from "./sidecar.js";

// Stamps every usage event with a repo identity, in this order:
//   1. the event's cwd, if it is still a repo checkout on disk (live);
//   2. the sidecar line the Stop hook wrote for that session (folder gone);
//   3. a keyed folder id, if the cwd is not a repo — whether it still exists
//      or the sidecar proves it did;
//   4. nothing — the server keeps it in the Inbox for a human.
// Every git call is cached per root and per cwd, so a sync over thousands
// of sessions costs a handful of spawns per distinct checkout.
export class IdentityResolver {
  private rootByCwd = new Map<string, string | null>();
  private identityByRoot = new Map<string, RepoIdentity | null>();
  private existsByCwd = new Map<string, boolean>();

  private constructor(
    private readonly installId: string,
    private readonly sidecar: Map<string, SidecarLine>,
  ) {}

  static async create(installId: string, sidecarPath?: string): Promise<IdentityResolver> {
    return new IdentityResolver(installId, await readSidecar(sidecarPath));
  }

  // The transcript's `gitBranch` reads "HEAD" for a detached checkout and
  // for every worktree parked on a commit; the Stop hook recorded the branch
  // the session's cwd was on. The server prefers the session's own branch
  // among candidate commits, so the better name goes on the wire.
  fixBranch(e: ParsedUsageEvent): void {
    const current = e.metadata.gitBranch;
    if (current && current !== "HEAD") return;
    const line = e.metadata.sessionId ? this.sidecar.get(e.metadata.sessionId) : undefined;
    if (line?.branch) e.metadata.gitBranch = line.branch;
  }

  async stamp(e: ParsedUsageEvent): Promise<void> {
    this.fixBranch(e);
    if (e.metadata.repo) return;
    const identity = await this.identityFor(e);
    if (identity) {
      e.metadata.repo = identity;
      e.metadata.placement = identity.source === "folder" ? "folder" : "cwd";
    }
  }

  // The repo a touched path falls under: first the roots the Stop hook
  // recorded for the session (the folder may be gone), then live git on
  // the path's directory. Null for a path in no repo. The most specific
  // root wins: a known root answers only when no checkout nested inside it
  // (a submodule) holds the path, so the answer never depends on which
  // turn resolved what first.
  async identityForPath(path: string, sessionId: string | undefined): Promise<RepoIdentity | null> {
    const roots = sessionId ? this.sidecar.get(sessionId)?.roots : undefined;
    const recorded = roots ? deepestRoot(Object.keys(roots), path) : null;
    if (recorded && (await this.answers(recorded, path))) return roots![recorded];
    // A path under a root already resolved live costs no spawn; otherwise
    // one git spawn per distinct existing directory, never per file (a
    // turn touches many files in few directories).
    const live = deepestRoot(this.liveRoots, path);
    if (live && (await this.answers(live, path))) return this.identityForRoot(live);
    const dir = await this.dirFor(path);
    if (!dir) return null;
    const root = await this.rootFor(dir);
    return root ? this.identityForRoot(root) : null;
  }

  // Whether a known root holds `path` itself, rather than a checkout nested
  // inside it. A path whose folder is gone climbs above the root: it holds.
  private async answers(root: string, path: string): Promise<boolean> {
    const dir = await this.dirFor(path);
    if (!dir) return true;
    const k = `${root}\u0000${dir}`;
    let nested = this.nestedByDir.get(k);
    if (nested === undefined) this.nestedByDir.set(k, (nested = await nestedCheckout(root, dir)));
    return !nested;
  }

  private async dirFor(path: string): Promise<string | null> {
    let dir = this.dirByPath.get(path);
    if (dir === undefined) this.dirByPath.set(path, (dir = await nearestDirectory(path)));
    return dir;
  }

  // The live checkout root for this event's cwd, or null when the folder is
  // gone or not a repo. Attribution reads commits from here.
  async liveRootFor(e: ParsedUsageEvent): Promise<string | null> {
    const cwd = e.metadata.cwd;
    return cwd ? this.rootFor(cwd) : null;
  }

  // A live checkout of this identity that no event's cwd pointed at: any
  // root the hook recorded for the key that still exists, or the main
  // checkout it recorded for a worktree that is gone. Null when this
  // machine holds no live checkout — usage ships, commits wait.
  async liveRootForKey(key: string): Promise<string | null> {
    let known = this.liveRootByKey.get(key);
    if (known !== undefined) return known;
    known = null;
    for (const line of this.sidecar.values()) {
      for (const [path, id] of Object.entries(line.roots ?? {})) {
        if (id.key !== key) continue;
        for (const candidate of [path, line.mains?.[path]]) {
          if (!candidate) continue;
          const root = await this.rootFor(candidate);
          if (root && (await this.identityForRoot(root))?.key === key) {
            known = root;
            break;
          }
        }
        if (known) break;
      }
      if (known) break;
    }
    this.liveRootByKey.set(key, known);
    return known;
  }

  // The branch the Stop hook saw for this session, or null (detached / no
  // sidecar). A dead worktree's commits are read from this ref in a sibling.
  sidecarBranchFor(e: ParsedUsageEvent): string | null {
    const line = e.metadata.sessionId ? this.sidecar.get(e.metadata.sessionId) : undefined;
    return line?.branch ?? null;
  }

  async identityFor(e: ParsedUsageEvent): Promise<RepoIdentity | null> {
    const cwd = e.metadata.cwd;
    const fromSidecar = e.metadata.sessionId ? this.sidecar.get(e.metadata.sessionId) : undefined;
    if (cwd) {
      const root = await this.rootFor(cwd);
      if (root) {
        const id = await this.identityForRoot(root);
        if (id) return id;
        return folderIdentity(cwd, this.installId); // repo with no remote and no commit
      }
      if (fromSidecar?.repo) return fromSidecar.repo;
      if (await this.exists(cwd)) {
        const stale = await staleWorktree(cwd);
        const mainRoot = stale ? await this.rootFor(stale.main) : null;
        const id = mainRoot ? await this.identityForRoot(mainRoot) : null;
        if (id && stale) return { ...id, label: basename(stale.folder) };
        return folderIdentity(cwd, this.installId);
      }
      // Gone, and the hook saw it as a plain folder: the same keyed id it
      // had while alive, so a rule set then still matches.
      if (fromSidecar) return folderIdentity(fromSidecar.cwd, this.installId);
      return null;
    }
    if (fromSidecar?.repo) return fromSidecar.repo;
    if (fromSidecar) return folderIdentity(fromSidecar.cwd, this.installId);
    return null;
  }

  private readonly liveRoots = new Set<string>();
  private readonly liveRootByKey = new Map<string, string | null>();
  private readonly dirByPath = new Map<string, string | null>();
  private readonly nestedByDir = new Map<string, boolean>();

  private async rootFor(cwd: string): Promise<string | null> {
    let root = this.rootByCwd.get(cwd);
    if (root === undefined) {
      root = await resolveRepoRoot(cwd);
      this.rootByCwd.set(cwd, root);
      if (root) this.liveRoots.add(root);
    }
    return root;
  }

  private async identityForRoot(root: string): Promise<RepoIdentity | null> {
    let id = this.identityByRoot.get(root);
    if (id === undefined) {
      id = await repoIdentity(root);
      this.identityByRoot.set(root, id);
    }
    return id;
  }

  private async exists(cwd: string): Promise<boolean> {
    let known = this.existsByCwd.get(cwd);
    if (known === undefined) {
      try {
        known = (await stat(cwd)).isDirectory();
      } catch {
        known = false;
      }
      this.existsByCwd.set(cwd, known);
    }
    return known;
  }
}
