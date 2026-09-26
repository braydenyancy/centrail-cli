import { stat } from "node:fs/promises";
import type { ParsedUsageEvent, RepoIdentity } from "@centrail/parsers";
import { resolveRepoRoot } from "./git.js";
import { folderIdentity, repoIdentity } from "./identity.js";
import { readSidecar, type SidecarLine } from "./sidecar.js";

// Stamps every usage event with a repo identity, in this order:
//   1. the event's cwd, if it is still a repo checkout on disk (live);
//   2. the sidecar line the Stop hook wrote for that session (folder gone);
//   3. a keyed folder id, if the cwd exists but is not a repo;
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

  async stamp(e: ParsedUsageEvent): Promise<void> {
    if (e.metadata.repo) return;
    const identity = await this.identityFor(e);
    if (identity) e.metadata.repo = identity;
  }

  // The live checkout root for this event's cwd, or null when the folder is
  // gone or not a repo. Attribution reads commits from here.
  async liveRootFor(e: ParsedUsageEvent): Promise<string | null> {
    const cwd = e.metadata.cwd;
    return cwd ? this.rootFor(cwd) : null;
  }

  // The branch the Stop hook saw for this session, or null (detached / no
  // sidecar). A dead worktree's commits are read from this ref in a sibling.
  sidecarBranchFor(e: ParsedUsageEvent): string | null {
    const line = e.metadata.sessionId ? this.sidecar.get(e.metadata.sessionId) : undefined;
    return line?.branch ?? null;
  }

  private async identityFor(e: ParsedUsageEvent): Promise<RepoIdentity | null> {
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
      if (await this.exists(cwd)) return folderIdentity(cwd, this.installId);
      return null;
    }
    if (fromSidecar?.repo) return fromSidecar.repo;
    if (fromSidecar) return folderIdentity(fromSidecar.cwd, this.installId);
    return null;
  }

  private async rootFor(cwd: string): Promise<string | null> {
    let root = this.rootByCwd.get(cwd);
    if (root === undefined) {
      root = await resolveRepoRoot(cwd);
      this.rootByCwd.set(cwd, root);
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
