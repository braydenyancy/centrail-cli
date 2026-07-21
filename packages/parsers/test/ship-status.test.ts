import { describe, expect, it } from "vitest";
import {
  computeCommitFates,
  UNSHIPPED_AFTER_DAYS,
  type ShipStatusFacts,
} from "../src/index.js";

const NOW = "2026-07-21T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

function iso(daysAgo: number): string {
  return new Date(Date.parse(NOW) - daysAgo * DAY_MS).toISOString();
}

function facts(partial: Partial<ShipStatusFacts>): ShipStatusFacts {
  return {
    defaultBranch: "main",
    shas: [],
    ancestorShas: [],
    cherryEquivalentShas: [],
    branchesBySha: {},
    branchTipDates: {},
    now: NOW,
    ...partial,
  };
}

describe("computeCommitFates — fate model", () => {
  it("marks ancestors of the default branch shipped", () => {
    const rows = computeCommitFates(
      facts({
        shas: [{ sha: "aaa", committedAt: iso(3) }],
        ancestorShas: ["aaa"],
        branchesBySha: { aaa: ["main"] },
        branchTipDates: { main: iso(0) },
      }),
    );
    expect(rows).toEqual([{ sha: "aaa", branch: "main", fate: "shipped" }]);
  });

  it("marks cherry-equivalent (squash-merged) commits shipped even off dormant branches", () => {
    const rows = computeCommitFates(
      facts({
        shas: [{ sha: "bbb", committedAt: iso(40) }],
        cherryEquivalentShas: ["bbb"],
        branchesBySha: { bbb: ["feature/x"] },
        branchTipDates: { "feature/x": iso(40) }, // dormant — shipped wins anyway
      }),
    );
    expect(rows).toEqual([{ sha: "bbb", branch: "feature/x", fate: "shipped" }]);
  });

  it("marks commits on a fresh branch in_flight", () => {
    const rows = computeCommitFates(
      facts({
        shas: [{ sha: "ccc", committedAt: iso(5) }],
        branchesBySha: { ccc: ["feature/y"] },
        branchTipDates: { "feature/y": iso(2) },
      }),
    );
    expect(rows).toEqual([{ sha: "ccc", branch: "feature/y", fate: "in_flight" }]);
  });

  it("marks commits whose only branches are dormant unshipped", () => {
    const rows = computeCommitFates(
      facts({
        shas: [{ sha: "ddd", committedAt: iso(60) }],
        branchesBySha: { ddd: ["feature/old", "origin/feature/old"] },
        branchTipDates: {
          "feature/old": iso(45),
          "origin/feature/old": iso(45),
        },
      }),
    );
    expect(rows).toEqual([
      { sha: "ddd", branch: "feature/old", fate: "unshipped" },
    ]);
  });

  it("marks branchless commits unshipped with a null branch", () => {
    const rows = computeCommitFates(
      facts({ shas: [{ sha: "eee", committedAt: iso(20) }] }),
    );
    expect(rows).toEqual([{ sha: "eee", branch: null, fate: "unshipped" }]);
  });

  it("a single fresh containing branch among dormant ones keeps it in_flight", () => {
    const rows = computeCommitFates(
      facts({
        shas: [{ sha: "fff", committedAt: iso(30) }],
        branchesBySha: { fff: ["feature/dead", "feature/alive"] },
        branchTipDates: {
          "feature/dead": iso(80),
          "feature/alive": iso(1),
        },
      }),
    );
    expect(rows[0].fate).toBe("in_flight");
  });

  it("treats a branch with an unknown tip date as not fresh", () => {
    const rows = computeCommitFates(
      facts({
        shas: [{ sha: "ggg", committedAt: iso(30) }],
        branchesBySha: { ggg: ["feature/gone"] },
        branchTipDates: { "feature/gone": null },
      }),
    );
    expect(rows[0].fate).toBe("unshipped");
  });
});

describe("computeCommitFates — 14-day boundary", () => {
  it(`exports UNSHIPPED_AFTER_DAYS = 14`, () => {
    expect(UNSHIPPED_AFTER_DAYS).toBe(14);
  });

  it("a tip exactly 14 days old is still in_flight; a millisecond older is unshipped", () => {
    const base = facts({
      shas: [{ sha: "hhh", committedAt: iso(15) }],
      branchesBySha: { hhh: ["feature/edge"] },
    });
    const atBoundary = computeCommitFates({
      ...base,
      branchTipDates: { "feature/edge": iso(UNSHIPPED_AFTER_DAYS) },
    });
    expect(atBoundary[0].fate).toBe("in_flight");

    const pastBoundary = computeCommitFates({
      ...base,
      branchTipDates: {
        "feature/edge": new Date(
          Date.parse(NOW) - UNSHIPPED_AFTER_DAYS * DAY_MS - 1,
        ).toISOString(),
      },
    });
    expect(pastBoundary[0].fate).toBe("unshipped");
  });
});

describe("computeCommitFates — branch naming", () => {
  it("prefers a local non-default branch over remote and default (unshipped commit)", () => {
    const rows = computeCommitFates(
      facts({
        shas: [{ sha: "iii", committedAt: iso(1) }],
        branchesBySha: {
          iii: ["main", "origin/feature/z", "feature/z"],
        },
        branchTipDates: { "feature/z": iso(0), "origin/feature/z": iso(0), main: iso(0) },
      }),
    );
    expect(rows[0].branch).toBe("feature/z");
  });

  it("labels ancestry-shipped commits with the DEFAULT branch even when stale feature branches still contain them (founder live finding 2026-07-21: 668 main-history commits labeled with one old merged branch)", () => {
    const rows = computeCommitFates(
      facts({
        shas: [{ sha: "sss", committedAt: iso(1) }],
        branchesBySha: {
          sss: ["main", "backfill-selfheal", "origin/backfill-selfheal"],
        },
        branchTipDates: { "backfill-selfheal": iso(0), main: iso(0) },
        ancestorShas: ["sss"],
      }),
    );
    expect(rows[0]).toEqual({ sha: "sss", branch: "main", fate: "shipped" });
  });

  it("squash-shipped (cherry-equivalent) commits KEEP their feature-branch label — that name carries real information", () => {
    const rows = computeCommitFates(
      facts({
        shas: [{ sha: "qqq", committedAt: iso(1) }],
        branchesBySha: { qqq: ["feature/squashed"] },
        branchTipDates: { "feature/squashed": iso(0) },
        cherryEquivalentShas: ["qqq"],
      }),
    );
    expect(rows[0]).toEqual({ sha: "qqq", branch: "feature/squashed", fate: "shipped" });
  });

  it("ancestry-shipped with no containing branch reports null branch, still shipped", () => {
    const rows = computeCommitFates(
      facts({
        shas: [{ sha: "nnn", committedAt: iso(1) }],
        branchesBySha: {},
        ancestorShas: ["nnn"],
      }),
    );
    expect(rows[0]).toEqual({ sha: "nnn", branch: null, fate: "shipped" });
  });

  it("strips the origin/ prefix when only a remote branch contains the sha", () => {
    const rows = computeCommitFates(
      facts({
        shas: [{ sha: "jjj", committedAt: iso(1) }],
        branchesBySha: { jjj: ["origin/feature/remote-only"] },
        branchTipDates: { "origin/feature/remote-only": iso(0) },
      }),
    );
    expect(rows[0]).toEqual({
      sha: "jjj",
      branch: "feature/remote-only",
      fate: "in_flight",
    });
  });

  it("falls back to the default branch name when only it contains the sha", () => {
    const rows = computeCommitFates(
      facts({
        shas: [{ sha: "kkk", committedAt: iso(1) }],
        ancestorShas: ["kkk"],
        branchesBySha: { kkk: ["origin/main"] },
        branchTipDates: { "origin/main": iso(0) },
      }),
    );
    expect(rows[0]).toEqual({ sha: "kkk", branch: "main", fate: "shipped" });
  });

  it("does not treat origin/<default> as a feature branch", () => {
    const rows = computeCommitFates(
      facts({
        shas: [{ sha: "lll", committedAt: iso(1) }],
        ancestorShas: ["lll"],
        branchesBySha: { lll: ["main", "origin/main"] },
        branchTipDates: { main: iso(0), "origin/main": iso(0) },
      }),
    );
    expect(rows[0].branch).toBe("main");
  });
});

describe("computeCommitFates — table sweep", () => {
  it("classifies a mixed repo in one pass", () => {
    const rows = computeCommitFates(
      facts({
        shas: [
          { sha: "s1", committedAt: iso(2) }, // shipped via ancestor
          { sha: "s2", committedAt: iso(20) }, // shipped via cherry
          { sha: "s3", committedAt: iso(4) }, // in_flight
          { sha: "s4", committedAt: iso(50) }, // unshipped dormant
          { sha: "s5", committedAt: iso(50) }, // unshipped branchless
        ],
        ancestorShas: ["s1"],
        cherryEquivalentShas: ["s2"],
        branchesBySha: {
          s1: ["main"],
          s2: ["feature/squashed"],
          s3: ["feature/wip"],
          s4: ["feature/stale"],
        },
        branchTipDates: {
          main: iso(0),
          "feature/squashed": iso(20),
          "feature/wip": iso(3),
          "feature/stale": iso(50),
        },
      }),
    );
    expect(rows.map((r) => r.fate)).toEqual([
      "shipped",
      "shipped",
      "in_flight",
      "unshipped",
      "unshipped",
    ]);
  });
});
