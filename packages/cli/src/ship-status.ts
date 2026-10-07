import {
  computeCommitFates,
  type CommitFateRow,
  type ShipStatusFacts,
} from "@centrail/parsers";
import {
  branchPrefixes,
  cherryEquivalentShas,
  listBranchTips,
  listReachableShas,
  listRecentShas,
  patchIds,
  readUserEmail,
  RECENT_SHA_CAP,
  resolveAncestryRef,
  resolveDefaultBranch,
  SQUASH_CANDIDATE_CAP,
  type BranchTip,
  type PrefixCommit,
  type RecentCommit,
} from "./git.js";
import { parkOutdated, type Config } from "./config.js";
import { progressStatus } from "./progress.js";
import { CliOutdatedError, minimumFrom } from "./update.js";
import { versionHeaders } from "./version.js";
import { toWireFate, type Capabilities, type WireFate } from "./wire.js";

export type { WireFate } from "./wire.js";

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
// Patch ids ride the same budget: two spawns per repo for own ids (every
// recent commit's when the server lists "patch-id", else only the squash
// candidates'), two for every branch prefix's cumulative id. Squash
// detection reads both, so it never spawns per candidate or per prefix.
export async function gatherShipStatusFacts(
  repoRoot: string,
  now: Date = new Date(),
  withPatchIds = false,
): Promise<GatheredFacts | null> {
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

  // One tip sha, one answer: a pushed branch and its origin/ twin share it.
  const tips = new Map<string, BranchTip>();
  for (const tip of cherryCandidates) if (!tips.has(tip.sha)) tips.set(tip.sha, tip);
  const cherrySet = new Set<string>();
  const prefixes: PrefixCommit[][] = [];
  for (const tip of tips.values()) {
    for (const sha of await cherryEquivalentShas(repoRoot, defaultBranch, tip.name)) {
      cherrySet.add(sha);
    }
    const prefix = await branchPrefixes(repoRoot, ancestryRef, tip.ref);
    if (prefix.length > 0) prefixes.push(prefix);
  }

  // A squash commit postdates the work it squashes: its candidates are the
  // default branch's commits since the prefix began, OLDEST first, capped —
  // a set later commits never change, so a squash once found stays found.
  // (The newest 200 lost it after 200 more commits, and the branch flipped
  // back from shipped.)
  const committedMs = new Map(shas.map((c) => [c.sha, Date.parse(c.committedAt)]));
  const candidates = prefixes.map((prefix) => {
    const since = Date.parse(prefix[0].at);
    return ancestorShas.filter((sha) => (committedMs.get(sha) ?? -Infinity) >= since).reverse().slice(0, SQUASH_CANDIDATE_CAP);
  });
  const own = withPatchIds ? shas.map((c) => c.sha) : [...new Set(candidates.flat())];
  const ownIds = await patchIds(repoRoot, own.map((sha) => ({ sha })));
  const cumulative = new Map(prefixes.flat().map((c) => [c.sha, c.base]));
  const prefixIds = await patchIds(repoRoot, [...cumulative].map(([sha, base]) => ({ sha, base })));

  const squashedInto: Record<string, string> = {};
  prefixes.forEach((prefix, i) => {
    for (const [sha, into] of Object.entries(matchSquash(prefix, candidates[i], ownIds, prefixIds))) {
      if (recent.has(sha)) squashedInto[sha] = into;
    }
  });
  const branchPatchIds: Record<string, string> = {};
  for (const [sha, id] of Object.entries(prefixIds)) {
    if (recent.has(sha) && !ancestors.has(sha)) branchPatchIds[sha] = id;
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
    patchIds: withPatchIds ? ownIds : {},
    branchPatchIds,
  };
}

// The facts plus the patch ids (§ 3.10), which decide no fate and only ride
// the wire: `patchIds` holds every recent commit's own id when asked for
// (a merge or root commit has none), `branchPatchIds` the cumulative id of
// each commit off the default branch, within the prefix cap.
export type GatheredFacts = ShipStatusFacts & {
  shas: RecentCommit[];
  patchIds: Record<string, string>;
  branchPatchIds: Record<string, string>;
};

// The default-branch commit a branch prefix landed as. A squash merge
// leaves the branch's commits off the default branch with no ancestor
// there, and `git cherry` compares one commit at a time, so a multi-commit
// branch never matches; the branch's cumulative patch does. Longest prefix
// first: a branch squashed twice maps to its latest squash, and work that
// continued after the squash stays unmapped.
function matchSquash(
  prefix: PrefixCommit[],
  candidates: string[],
  own: Record<string, string>,
  cumulative: Record<string, string>,
): Record<string, string> {
  const byId = new Map<string, string>();
  for (const sha of candidates) {
    const id = own[sha];
    if (id) byId.set(id, sha); // oldest first: one patch landed twice maps to its latest landing
  }
  for (let k = prefix.length; k >= 1; k--) {
    const id = cumulative[prefix[k - 1].sha];
    const into = id ? byId.get(id) : undefined;
    if (into) return Object.fromEntries(prefix.slice(0, k).map((c) => [c.sha, into]));
  }
  return {};
}

// Fate pass over the repos the attribution push already resolved. Returns the
// aggregate tally, or null when NO repo had a fate pass (all defaults
// unresolvable / no repos) — callers omit the output line then. Best-effort
// like attribution: failures warn, and only a refused CLI version (426)
// throws.
//
// `machineId` (the random install id) is given only for a server that lists
// "repo", and the `facts` block rides with it (§ 3.10). Each row is shaped by
// toWireFate from `caps` — absent, it is read from `machineId`: "repo" or
// nothing. Without "repo" every row is the 0.5.1 shape — repo name, sha,
// branch, fate — plus the patch ids when the server lists "patch-id".
// `name` and `key` arrive as the wire carries them (wireRepoRef); toWireFate
// drops the branch under hideBranchNames.
export async function runFatePass(
  auth: { baseUrl: string; token: string },
  repos: { root?: string; roots?: string[]; name: string; key?: string }[],
  declared: WireRepo[] = [],
  machineId?: string,
  caps: Capabilities = { fields: new Set(machineId ? ["repo"] : []) },
  cfg: Pick<Config, "hideBranchNames"> = { hideBranchNames: false },
): Promise<FateTally | null> {
  let anyRepoPassed = false;
  const tally: FateTally = { shipped: 0, inFlight: 0, unshipped: 0 };

  for (const [i, { root: one, roots: many, name, key }] of repos.entries()) {
    progressStatus(`Checking ship status — ${i + 1}/${repos.length} repos`); // git per repo: seconds each on a big one
    const roots = many ?? (one ? [one] : []);
    const facts = await gatherShipStatusFactsForRoots(roots, caps.fields.has("patch-id"));
    if (!facts) continue; // no resolvable default branch — skip, never guess
    anyRepoPassed = true;
    const root = roots[0];
    const email = await readUserEmail(root);
    const bySha = new Map<string, RecentCommit>((facts.shas as RecentCommit[]).map((c) => [c.sha, c]));
    const ancestors = new Set(facts.ancestorShas);
    const rows: CommitFateRow[] = computeCommitFates(facts);
    const fates: WireFate[] = [];
    for (const row of rows) {
      if (row.fate === "shipped") tally.shipped++;
      else if (row.fate === "in_flight") tally.inFlight++;
      else tally.unshipped++;
      const commit = bySha.get(row.sha);
      fates.push(
        toWireFate(
          {
            repoName: name,
            repoKey: key,
            row,
            commit,
            mine: email && commit?.authorEmail ? commit.authorEmail === email : undefined,
            patchId: facts.patchIds[row.sha],
            branchPatchId: ancestors.has(row.sha) ? undefined : facts.branchPatchIds[row.sha],
          },
          caps,
          cfg,
        ),
      );
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

type MergedFacts = GatheredFacts & { complete: boolean };

// Facts for every live checkout of one identity, unioned: a sha alive in
// any clone is alive; containment, ancestry, cherry and squash facts add up.
// Incomplete when any clone hit the sha cap.
export async function gatherShipStatusFactsForRoots(roots: string[], withPatchIds = false): Promise<MergedFacts | null> {
  let merged: MergedFacts | null = null;
  for (const root of roots) {
    const f = await gatherShipStatusFacts(root, new Date(), withPatchIds);
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
    merged.patchIds = { ...merged.patchIds, ...f.patchIds }; // a content hash: equal in every clone
    merged.branchPatchIds = { ...merged.branchPatchIds, ...f.branchPatchIds };
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
// the sync, and we never read any fates-specific response field. A 426 is
// the one refusal that does: it is about this version, not the section.
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
      if (res.status === 426) throw new CliOutdatedError(await parkOutdated(await minimumFrom(res)));
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
    if (err instanceof CliOutdatedError) throw err; // best-effort, but not past a refused version
    console.warn("  ⚠ Ship-status request failed:", (err as Error).message);
  }
}

export function formatShipStatusLine(tally: FateTally): string {
  return `ship status: ${tally.shipped} shipped / ${tally.inFlight} in flight / ${tally.unshipped} unshipped`;
}
