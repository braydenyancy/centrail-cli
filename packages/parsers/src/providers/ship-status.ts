// Pure ship-status (commit fate) logic. The CLI's git.ts shells out to gather
// repo facts as plain data and feeds them here — every fate DECISION lives in
// this module so it is unit-testable without a real repo. No I/O.
//
// Fate model (v1, deliberately simple):
//   shipped   — the commit is an ancestor of the default branch tip, OR its
//               patch is squash-equivalent to one on default (`git cherry`).
//   in_flight — not shipped, and some branch containing it has a tip commit
//               newer than UNSHIPPED_AFTER_DAYS.
//   unshipped — not shipped and no containing branch has recent activity
//               (dormant or deleted).

export const UNSHIPPED_AFTER_DAYS = 14;

export type CommitFate = "shipped" | "in_flight" | "unshipped";

export type ShipStatusFacts = {
  // Resolved default branch name (e.g. "main"). Never empty — the CLI skips
  // the fate pass for a repo when it cannot resolve a default branch.
  defaultBranch: string;
  // Recent commits (`git log --all --since=90 days`, capped): sha + ISO date.
  shas: { sha: string; committedAt: string }[];
  // Shas that are ancestors of the default branch tip.
  ancestorShas: string[];
  // Shas whose patch is squash-equivalent to one on default
  // (`git cherry <default> <tip>` reported "-").
  cherryEquivalentShas: string[];
  // sha -> containing branch short names exactly as git prints them
  // ("feature/x", "origin/feature/x"; includes the default when it contains
  // the sha). Missing/empty = no branch contains the sha anymore.
  branchesBySha: Record<string, string[]>;
  // branch short name (same spelling as branchesBySha values) -> tip
  // committer date (ISO), or null when unknown.
  branchTipDates: Record<string, string | null>;
  // Evaluation time (ISO). Injected so fate decisions are deterministic.
  now: string;
};

export type CommitFateRow = {
  sha: string;
  // Shipped-via-ancestry commits report the DEFAULT branch: once a commit is
  // on default, stale merged-but-undeleted branches still "contain" it and
  // the first-containing label degenerates to noise (observed live
  // 2026-07-21: 668 of a repo's main-history commits labeled with one old
  // feature branch). The feature-branch name only carries information for
  // squash-shipped (cherry-equivalent) and unshipped/in-flight commits, so:
  //   shipped via ancestry — the default branch name (null if branchless).
  //   everything else — first containing non-default branch (local preferred
  //   over remote, "origin/" stripped); default name when only default
  //   contains it; null when no branch contains the sha at all.
  branch: string | null;
  fate: CommitFate;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeCommitFates(facts: ShipStatusFacts): CommitFateRow[] {
  const ancestors = new Set(facts.ancestorShas);
  const cherryEquivalent = new Set(facts.cherryEquivalentShas);
  const nowMs = Date.parse(facts.now);
  const freshWindowMs = UNSHIPPED_AFTER_DAYS * DAY_MS;
  const isDefault = (b: string) =>
    b === facts.defaultBranch || b === `origin/${facts.defaultBranch}`;

  const out: CommitFateRow[] = [];
  for (const { sha } of facts.shas) {
    const containing = facts.branchesBySha[sha] ?? [];
    const shippedViaAncestry = ancestors.has(sha);

    // Branch naming (see CommitFateRow.branch): ancestry-shipped commits
    // belong to the default branch; the first-containing rule applies to
    // everything else, local before remote, "origin/" stripped.
    let branch: string | null;
    if (shippedViaAncestry) {
      branch = containing.length > 0 ? facts.defaultBranch : null;
    } else {
      const nonDefault = containing.filter((b) => !isDefault(b));
      const local = nonDefault.find((b) => !b.startsWith("origin/"));
      const remote = nonDefault.find((b) => b.startsWith("origin/"));
      branch =
        local ??
        (remote !== undefined
          ? remote.slice("origin/".length)
          : containing.length > 0
            ? facts.defaultBranch
            : null);
    }

    let fate: CommitFate;
    if (shippedViaAncestry || cherryEquivalent.has(sha)) {
      fate = "shipped";
    } else {
      const hasFreshBranch = containing.some((b) => {
        const tip = facts.branchTipDates[b];
        if (!tip) return false;
        const tipMs = Date.parse(tip);
        if (!Number.isFinite(tipMs)) return false;
        // Tip ≤ 14 days old counts as live (future dates trivially qualify).
        return nowMs - tipMs <= freshWindowMs;
      });
      fate = hasFreshBranch ? "in_flight" : "unshipped";
    }

    out.push({ sha, branch, fate });
  }
  return out;
}
