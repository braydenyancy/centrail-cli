import {
  computeCommitFates,
  type CommitFateRow,
  type ShipStatusFacts,
} from "@centrail/parsers";
import {
  cherryEquivalentShas,
  listBranchTips,
  listReachableShas,
  listRecentShas,
  readUserEmail,
  RECENT_SHA_CAP,
  resolveAncestryRef,
  squashedShas,
  resolveDefaultBranch,
  type BranchTip,
  type RecentCommit,
} from "./git.js";
import { versionHeaders } from "./version.js";

// Wire row for the optional `fates` section of POST /api/cli/attribute.
// The first four fields are the 0.5.1 row; the rest go only to a server
// that lists "repo" (§ 3.10). Every field named; no row is ever spread.
export type WireFate = {
  repoName: string;
  repoKey?: string;
  commitSha: string;
  branch: string | null;
  fate: "shipped" | "in_flight" | "unshipped";
  // The commit's facts (§ 3.8): a server that advertises "match" attributes
  // this user's still-unattributed events of `repoKey` to these commits.
  committedAt?: string;
  linesAdded?: number;
  linesDeleted?: number;
  filesChanged?: number;
  mergedAs?: string; // squashed into this default-branch commit (§ ship status)
  // The commit's author is this machine's git identity. Absent when either
  // side is unknown. The server prefers own commits when several fit; a
  // teammate's commit never absorbs this user's tokens by time alone.
  mine?: boolean;
};

// What one fates call says about itself: which machine reported and whether
// the set is every recent commit of the repo (under the sha cap). From a
// complete set the server can tell which shas vanished — rewritten,
// squashed, their branch deleted — and re-match their events.
export type WireFacts = { machineId: string; complete: boolean };

// The repos section the attribute route already knows, declared with the
// first fates call when the server matches (no attributions call then).
export type WireRepo = { name: string; key?: string; totalLoc: number | null; fileCount: number };

export type FateTally = { shipped: number; inFlight: number; unshipped: number };

// Mirrors the server's batch cap for fate rows.
const FATE_CHUNK = 2000;

const WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// Gather the git facts for one repo. Null when the default branch cannot be
// resolved — the caller skips the repo entirely (never guess a default).
// Performance: spawns scale with LIVE BRANCHES, not commits. One
// `for-each-ref` lists every tip with its date; one `rev-list --since` per
// branch whose tip is inside the window gives containment, and one more on
// the default branch gives ancestry. A branch whose tip is older than the
// window cannot contain a commit inside it, so stale branches cost nothing.
// (Was `branch --contains` + `merge-base` per sha: ~4,000 spawns per repo.)
export async function gatherShipStatusFacts(
  repoRoot: string,
  now: Date = new Date(),
): Promise<(ShipStatusFacts & { shas: RecentCommit[] }) | null> {
  const defaultBranch = await resolveDefaultBranch(repoRoot);
  if (!defaultBranch) return null;

  const shas: RecentCommit[] = await listRecentShas(repoRoot, WINDOW_DAYS);
  const recent = new Set(shas.map((s) => s.sha));
  const cutoffMs = now.getTime() - WINDOW_DAYS * DAY_MS;

  const ancestryRef = await resolveAncestryRef(repoRoot, defaultBranch);
  const ancestorShas = (
    await listReachableShas(repoRoot, ancestryRef, WINDOW_DAYS)
  ).filter((sha) => recent.has(sha));
  const ancestors = new Set(ancestorShas);

  const isDefaultRef = (b: string) =>
    b === defaultBranch || b === `origin/${defaultBranch}`;
  const branchesBySha: Record<string, string[]> = {};
  const branchTipDates: Record<string, string | null> = {};
  const cherryCandidates: BranchTip[] = [];
  for (const tip of await listBranchTips(repoRoot)) {
    const tipMs = tip.tipDate ? Date.parse(tip.tipDate) : Number.NaN;
    if (Number.isFinite(tipMs) && tipMs < cutoffMs) continue; // unparsable date: keep, be safe
    branchTipDates[tip.name] = tip.tipDate;
    let unmerged = false;
    for (const sha of await listReachableShas(repoRoot, tip.ref, WINDOW_DAYS)) {
      if (!recent.has(sha)) continue;
      (branchesBySha[sha] ??= []).push(tip.name);
      if (!ancestors.has(sha)) unmerged = true;
    }
    // `git cherry` only matters for a branch that still holds a recent commit
    // NOT on default — that is the squash-merge case. A fully merged branch,
    // or the default itself, cannot add a cherry-equivalent sha we report.
    if (unmerged && !isDefaultRef(tip.name)) cherryCandidates.push(tip);
  }

  const cherrySet = new Set<string>();
  const squashedInto: Record<string, string> = {};
  for (const tip of cherryCandidates) {
    for (const sha of await cherryEquivalentShas(repoRoot, defaultBranch, tip.name)) {
      cherrySet.add(sha);
    }
    for (const [sha, into] of Object.entries(await squashedShas(repoRoot, ancestryRef, tip.ref))) {
      if (recent.has(sha)) squashedInto[sha] = into;
    }
  }

  return {
    defaultBranch,
    shas,
    ancestorShas,
    cherryEquivalentShas: [...cherrySet],
    squashedInto,
    branchesBySha,
    branchTipDates,
    now: now.toISOString(),
  };
}

// Fate pass over the repos the attribution push already resolved. Returns the
// aggregate tally, or null when NO repo had a fate pass (all defaults
// unresolvable / no repos) — callers omit the output line then. Best-effort
// like attribution: failures warn, never throw.
//
// `machineId` (the random install id) is given only for a server that lists
// "repo": the commit facts, `mine`, `mergedAs` and the `facts` block ride
// with it (§ 3.10). Without it every row is the 0.5.1 shape — repo name,
// sha, branch, fate — and nothing else.
export async function runFatePass(
  auth: { baseUrl: string; token: string },
  repos: { root?: string; roots?: string[]; name: string; key?: string }[],
  declared: WireRepo[] = [],
  machineId?: string,
): Promise<FateTally | null> {
  let anyRepoPassed = false;
  const tally: FateTally = { shipped: 0, inFlight: 0, unshipped: 0 };

  for (const { root: one, roots: many, name, key } of repos) {
    const roots = many ?? (one ? [one] : []);
    const facts = await gatherShipStatusFactsForRoots(roots);
    if (!facts) continue; // no resolvable default branch — skip, never guess
    anyRepoPassed = true;
    const root = roots[0];
    const email = await readUserEmail(root);
    const bySha = new Map<string, RecentCommit>((facts.shas as RecentCommit[]).map((c) => [c.sha, c]));
    const rows: CommitFateRow[] = computeCommitFates(facts);
    const fates: WireFate[] = [];
    for (const row of rows) {
      if (row.fate === "shipped") tally.shipped++;
      else if (row.fate === "in_flight") tally.inFlight++;
      else tally.unshipped++;
      if (!machineId) {
        fates.push({ repoName: name, commitSha: row.sha, branch: row.branch, fate: row.fate });
        continue;
      }
      const c = bySha.get(row.sha);
      const mine = email && c?.authorEmail ? c.authorEmail === email : undefined;
      fates.push({
        repoName: name,
        ...(key ? { repoKey: key } : {}),
        commitSha: row.sha,
        branch: row.branch,
        fate: row.fate,
        ...(row.mergedAs ? { mergedAs: row.mergedAs } : {}),
        committedAt: c?.committedAt ?? "",
        linesAdded: c?.linesAdded ?? 0,
        linesDeleted: c?.linesDeleted ?? 0,
        filesChanged: c?.filesChanged ?? 0,
        ...(mine === undefined ? {} : { mine }),
      });
    }
    // One call per repo, declaring only that repo, so the server sees a
    // whole set at once. `complete` is false at the sha cap: an incomplete
    // set proves nothing about what vanished.
    const own = declared.filter((r) => (key && r.key === key) || r.name === name);
    await pushFates(auth, fates, own, machineId ? { machineId, complete: facts.complete } : undefined);
  }
  if (!anyRepoPassed) return null;
  return tally;
}

type MergedFacts = ShipStatusFacts & { shas: RecentCommit[]; complete: boolean };

// Facts for every live checkout of one identity, unioned: a sha alive in
// any clone is alive; containment, ancestry, cherry and squash facts add up.
// Incomplete when any clone hit the sha cap.
export async function gatherShipStatusFactsForRoots(roots: string[]): Promise<MergedFacts | null> {
  let merged: MergedFacts | null = null;
  for (const root of roots) {
    const f = await gatherShipStatusFacts(root);
    if (!f) continue;
    const complete = f.shas.length < RECENT_SHA_CAP;
    if (!merged) {
      merged = { ...f, complete };
      continue;
    }
    const seen = new Set(merged.shas.map((c) => c.sha));
    for (const c of f.shas) if (!seen.has(c.sha)) merged.shas.push(c);
    merged.ancestorShas = [...new Set([...merged.ancestorShas, ...f.ancestorShas])];
    merged.cherryEquivalentShas = [...new Set([...merged.cherryEquivalentShas, ...f.cherryEquivalentShas])];
    merged.squashedInto = { ...(merged.squashedInto ?? {}), ...(f.squashedInto ?? {}) };
    for (const [sha, branches] of Object.entries(f.branchesBySha)) {
      merged.branchesBySha[sha] = [...new Set([...(merged.branchesBySha[sha] ?? []), ...branches])];
    }
    for (const [b, d] of Object.entries(f.branchTipDates)) if (!(b in merged.branchTipDates)) merged.branchTipDates[b] = d;
    merged.complete = merged.complete && complete;
  }
  return merged;
}

// POST one repo's fates to /api/cli/attribute (the cap equals the chunk, so
// one call; chunked defensively). Old
// servers may ignore or reject the section — either way this must not fail
// the sync, and we never read any fates-specific response field.
async function pushFates(
  auth: { baseUrl: string; token: string },
  fates: WireFate[],
  repos: WireRepo[],
  facts?: WireFacts,
): Promise<void> {
  if (fates.length === 0) return;
  try {
    for (let i = 0; i < fates.length; i += FATE_CHUNK) {
      const chunk = fates.slice(i, i + FATE_CHUNK);
      const res = await fetch(`${auth.baseUrl}/api/cli/attribute`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${auth.token}`,
          ...versionHeaders(),
        },
        body: JSON.stringify({ repos, attributions: [], fates: chunk, ...(facts ? { facts } : {}) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        console.warn(
          `  ⚠ Ship-status chunk skipped (${res.status})${body?.error ? `: ${body.error}` : ""}.`,
        );
      }
      // 2xx: nothing to read — the fate wire is fire-and-forget and must not
      // depend on the server recognizing `fates` yet.
    }
  } catch (err) {
    console.warn("  ⚠ Ship-status request failed:", (err as Error).message);
  }
}

export function formatShipStatusLine(tally: FateTally): string {
  return `ship status: ${tally.shipped} shipped / ${tally.inFlight} in flight / ${tally.unshipped} unshipped`;
}
