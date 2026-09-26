import { dirname } from "node:path";
import type { Evidence, ParsedUsageEvent, Placement, RepoIdentity } from "@centrail/parsers";
import type { IdentityResolver } from "./resolver.js";

// One repo per turn (docs/decisions/2026-09-system-audit.md § 3.9). Across
// 80,164 turns on the reference machine no turn named two repos, so a turn
// is placed whole and every request in it gets the same home — totals
// never split. The order, per turn:
//   cwd     the session's folder is inside a repo: that repo, always;
//   files   its edits name one repo — or, failing that, its reads;
//   sticky  the session's previous turn was placed: the same;
//   folder  the folder's own keyed id (a workstream root, the home dir).
// Paths resolve through the roots the Stop hook recorded for the session
// (so a deleted worktree still places) and then live git. Pure over its
// inputs, so a `--full` rescan places every old event exactly as the
// incremental sync did.
export class Placer {
  constructor(private readonly resolver: IdentityResolver) {}

  async place(events: ParsedUsageEvent[]): Promise<void> {
    const sessions = new Map<string, ParsedUsageEvent[]>();
    for (const e of events) {
      if (e.metadata.repo) continue;
      const sid = e.metadata.sessionId;
      if (!sid || !e.metadata.turn) {
        await this.resolver.stamp(e); // no session or turn to reason over: cwd → sidecar → folder
        continue;
      }
      let list = sessions.get(sid);
      if (!list) sessions.set(sid, (list = []));
      list.push(e);
    }
    for (const list of sessions.values()) await this.placeSession(list);
  }

  private async placeSession(events: ParsedUsageEvent[]): Promise<void> {
    events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    // Turns in order of their first request.
    const turns = new Map<string, ParsedUsageEvent[]>();
    for (const e of events) {
      const id = e.metadata.turn!;
      let t = turns.get(id);
      if (!t) turns.set(id, (t = []));
      t.push(e);
    }
    let sticky: RepoIdentity | null = null;
    for (const turn of turns.values()) {
      const base = await this.resolver.identityFor(turn[0]);
      let repo: RepoIdentity | null = null;
      let placement: Placement | null = null;
      if (base && base.source !== "folder") {
        repo = base;
        placement = "cwd";
      } else {
        const evidence = turn.reduce<Evidence>((acc, e) => merge(acc, e.metadata.touched), { writes: [], reads: [] });
        const byFiles = (await this.namedRepo(evidence.writes, turn[0])) ?? (await this.namedRepo(evidence.reads, turn[0]));
        if (byFiles) {
          repo = byFiles;
          placement = "files";
        } else if (sticky) {
          repo = sticky;
          placement = "sticky";
        } else if (base) {
          repo = base;
          placement = "folder";
        }
      }
      if (repo && placement) {
        for (const e of turn) {
          e.metadata.repo = repo;
          e.metadata.placement = placement;
        }
        if (placement !== "folder") sticky = repo;
      }
    }
  }

  // The one repo a set of paths names: the identity most of them fall
  // under, so two repos in one turn (unmeasured, never observed) yield a
  // home and not a split. Null when none of the paths is in a repo.
  private async namedRepo(paths: string[], e: ParsedUsageEvent): Promise<RepoIdentity | null> {
    const votes = new Map<string, { repo: RepoIdentity; n: number }>();
    for (const path of paths) {
      const repo = await this.resolver.identityForPath(path, e.metadata.sessionId);
      if (!repo) continue;
      const v = votes.get(repo.key);
      if (v) v.n++;
      else votes.set(repo.key, { repo, n: 1 });
    }
    let best: { repo: RepoIdentity; n: number } | null = null;
    for (const v of votes.values()) if (!best || v.n > best.n) best = v;
    return best?.repo ?? null;
  }
}

function merge(a: Evidence, b: Evidence | undefined): Evidence {
  if (!b) return a;
  return { writes: [...new Set([...a.writes, ...b.writes])], reads: [...new Set([...a.reads, ...b.reads])] };
}

// The directory a path's repo would be looked up from: the path itself if
// it names a directory the caller already knows, else its parent. Callers
// pass either; the resolver tries the path first and its parent second.
export function lookupDirs(path: string): string[] {
  const parent = dirname(path);
  return parent === path ? [path] : [path, parent];
}
