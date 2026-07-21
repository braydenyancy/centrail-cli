import {
  computeCommitFates,
  type CommitFateRow,
  type ShipStatusFacts,
} from "@centrail/parsers";
import {
  branchTipDate,
  branchesContaining,
  cherryEquivalentShas,
  isAncestor,
  listRecentShas,
  resolveDefaultBranch,
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

// Gather the git facts for one repo. Null when the default branch cannot be
// resolved — the caller skips the repo entirely (never guess a default).
// Performance: `git cherry` runs once per branch TIP (not per commit);
// ancestor checks are one cheap merge-base per sha (capped at 2000).
export async function gatherShipStatusFacts(
  repoRoot: string,
  now: Date = new Date(),
): Promise<ShipStatusFacts | null> {
  const defaultBranch = await resolveDefaultBranch(repoRoot);
  if (!defaultBranch) return null;

  const shas = await listRecentShas(repoRoot, 90);

  const branchesBySha: Record<string, string[]> = {};
  const allBranches = new Set<string>();
  for (const { sha } of shas) {
    const branches = await branchesContaining(repoRoot, sha);
    branchesBySha[sha] = branches;
    for (const b of branches) allBranches.add(b);
  }

  const branchTipDates: Record<string, string | null> = {};
  for (const branch of allBranches) {
    branchTipDates[branch] = await branchTipDate(repoRoot, branch);
  }

  const isDefaultRef = (b: string) =>
    b === defaultBranch || b === `origin/${defaultBranch}`;
  const cherrySet = new Set<string>();
  for (const branch of allBranches) {
    if (isDefaultRef(branch)) continue;
    for (const sha of await cherryEquivalentShas(repoRoot, defaultBranch, branch)) {
      cherrySet.add(sha);
    }
  }

  const ancestorShas: string[] = [];
  for (const { sha } of shas) {
    if (await isAncestor(repoRoot, sha, defaultBranch)) ancestorShas.push(sha);
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
