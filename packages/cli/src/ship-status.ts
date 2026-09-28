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
  resolveDefaultBranch,
  type BranchTip,
} from "./git.js";
import { versionHeaders } from "./version.js";

// Wire row for the optional `fates` section of POST /api/cli/attribute.
export type WireFate = {
  repoName: string;
  commitSha: string;
  branch: string | null;
  fate: "shipped" | "in_flight" | "unshipped";
};

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
): Promise<ShipStatusFacts | null> {
  const defaultBranch = await resolveDefaultBranch(repoRoot);
  if (!defaultBranch) return null;

  const shas = await listRecentShas(repoRoot, WINDOW_DAYS);
  const recent = new Set(shas.map((s) => s.sha));
  const cutoffMs = now.getTime() - WINDOW_DAYS * DAY_MS;

  const ancestorShas = (
    await listReachableShas(repoRoot, `refs/heads/${defaultBranch}`, WINDOW_DAYS)
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
  for (const tip of cherryCandidates) {
    for (const sha of await cherryEquivalentShas(repoRoot, defaultBranch, tip.name)) {
      cherrySet.add(sha);
    }
  }

  return {
    defaultBranch,
    shas,
    ancestorShas,
    cherryEquivalentShas: [...cherrySet],
    branchesBySha,
    branchTipDates,
    now: now.toISOString(),
  };
}

// Fate pass over the repos the attribution push already resolved. Returns the
// aggregate tally, or null when NO repo had a fate pass (all defaults
// unresolvable / no repos) — callers omit the output line then. Best-effort
// like attribution: failures warn, never throw.
export async function runFatePass(
  auth: { baseUrl: string; token: string },
  repos: { root: string; name: string }[],
): Promise<FateTally | null> {
  const fates: WireFate[] = [];
  let anyRepoPassed = false;
  const tally: FateTally = { shipped: 0, inFlight: 0, unshipped: 0 };

  for (const { root, name } of repos) {
    const facts = await gatherShipStatusFacts(root);
    if (!facts) continue; // no resolvable default branch — skip, never guess
    anyRepoPassed = true;
    const rows: CommitFateRow[] = computeCommitFates(facts);
    for (const row of rows) {
      if (row.fate === "shipped") tally.shipped++;
      else if (row.fate === "in_flight") tally.inFlight++;
      else tally.unshipped++;
      fates.push({
        repoName: name,
        commitSha: row.sha,
        branch: row.branch,
        fate: row.fate,
      });
    }
  }
  if (!anyRepoPassed) return null;

  await pushFates(auth, fates);
  return tally;
}

// POST fates to /api/cli/attribute in fates-only calls (chunked ≤2000). Old
// servers may ignore or reject the section — either way this must not fail
// the sync, and we never read any fates-specific response field.
async function pushFates(
  auth: { baseUrl: string; token: string },
  fates: WireFate[],
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
        body: JSON.stringify({ repos: [], attributions: [], fates: chunk }),
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
