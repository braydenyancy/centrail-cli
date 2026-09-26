import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const git = vi.hoisted(() => ({
  resolveDefaultBranch: vi.fn(),
  listRecentShas: vi.fn(),
  readUserEmail: vi.fn(),
  resolveAncestryRef: vi.fn(),
  squashedShas: vi.fn(),
  RECENT_SHA_CAP: 2000,
  listBranchTips: vi.fn(),
  listReachableShas: vi.fn(),
  cherryEquivalentShas: vi.fn(),
}));
vi.mock("./git.js", () => git);

import {
  formatShipStatusLine,
  gatherShipStatusFacts,
  runFatePass,
} from "./ship-status.js";

const AUTH = { baseUrl: "https://centrail.org", token: "tok" };

const fetchMock = vi.fn();
const NOW = new Date("2026-07-21T12:00:00.000Z");

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

// One repo: sha "aaa" merged to main, "bbb" live on feature/x, "ccc" only on
// a dormant branch, "ddd" on a branch whose tip fell out of the 90-day window.
function tip(name: string, tipDate: string) {
  return { ref: `refs/heads/${name}`, name, sha: `tip-${name}`, tipDate };
}
function stubHappyRepo(): void {
  git.resolveDefaultBranch.mockResolvedValue("main");
  git.readUserEmail.mockResolvedValue("me@example.com");
  git.resolveAncestryRef.mockResolvedValue("refs/heads/main");
  git.squashedShas.mockResolvedValue({});
  git.listRecentShas.mockResolvedValue([
    { sha: "aaa", committedAt: daysAgo(1), linesAdded: 10, linesDeleted: 2, filesChanged: 3, authorEmail: "me@example.com" },
    { sha: "bbb", committedAt: daysAgo(2), linesAdded: 0, linesDeleted: 0, filesChanged: 0, authorEmail: "teammate@example.com" },
    { sha: "ccc", committedAt: daysAgo(40), linesAdded: 7, linesDeleted: 7, filesChanged: 1 },
  ]);
  git.listBranchTips.mockResolvedValue([
    tip("main", daysAgo(0)),
    tip("feature/x", daysAgo(1)),
    tip("feature/dead", daysAgo(40)),
    tip("feature/merged", daysAgo(1)),
    tip("feature/ancient", daysAgo(200)),
  ]);
  git.listReachableShas.mockImplementation(async (_root: string, ref: string) => {
    if (ref === "refs/heads/main") return ["aaa", "older-than-window-not-in-recent"];
    if (ref === "refs/heads/feature/x") return ["bbb"];
    if (ref === "refs/heads/feature/dead") return ["ccc"];
    if (ref === "refs/heads/feature/merged") return ["aaa"]; // fully on main already
    throw new Error(`rev-list must not run on a stale branch: ${ref}`);
  });
  git.cherryEquivalentShas.mockResolvedValue([]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  for (const fn of Object.values(git)) if (typeof fn === "function") fn.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("gatherShipStatusFacts", () => {
  it("returns null (skip repo) when no default branch resolves", async () => {
    git.resolveDefaultBranch.mockResolvedValue(null);
    expect(await gatherShipStatusFacts("/repo")).toBeNull();
    expect(git.listRecentShas).not.toHaveBeenCalled();
  });

  it("spawns per live branch, never per commit, and skips branches outside the window", async () => {
    stubHappyRepo();
    const facts = await gatherShipStatusFacts("/repo", NOW);
    expect(facts?.defaultBranch).toBe("main");
    // 3 commits, 5 branches, 1 stale -> rev-list once for default ancestry
    // + once per live branch (4); cherry only for live branches that still
    // hold a recent commit off main (2): the merged branch and main are skipped.
    expect(git.listReachableShas).toHaveBeenCalledTimes(5);
    expect(git.cherryEquivalentShas).toHaveBeenCalledTimes(2);
    const tips = git.cherryEquivalentShas.mock.calls.map((c) => c[2]).sort();
    expect(tips).toEqual(["feature/dead", "feature/x"]);
    expect(facts?.ancestorShas).toEqual(["aaa"]);
    expect(facts?.branchesBySha).toEqual({
      aaa: ["main", "feature/merged"],
      bbb: ["feature/x"],
      ccc: ["feature/dead"],
    });
    expect(facts?.branchTipDates).not.toHaveProperty("feature/ancient");
  });
});

describe("gatherShipStatusFacts squash detection", () => {
  it("ancestry follows the ref git.resolveAncestryRef names (origin/main on a parked worktree); a squashed branch's shas carry mergedAs and read shipped", async () => {
    stubHappyRepo();
    git.resolveAncestryRef.mockResolvedValue("refs/remotes/origin/main");
    git.listReachableShas.mockImplementation(async (_root: string, ref: string) => {
      if (ref === "refs/remotes/origin/main") return ["aaa", "sss"];
      if (ref === "refs/heads/main") return ["aaa"]; // the stale local main: still a branch for containment, never for ancestry
      if (ref === "refs/heads/feature/x") return ["bbb"];
      if (ref === "refs/heads/feature/dead") return ["ccc"];
      if (ref === "refs/heads/feature/merged") return ["aaa"];
      throw new Error(`rev-list must not run on a stale branch: ${ref}`);
    });
    git.squashedShas.mockImplementation(async (_root: string, _def: string, tip: string) => (tip === "refs/heads/feature/x" ? { bbb: "sss" } : {}));
    const facts = (await gatherShipStatusFacts("/repo", NOW))!;
    expect(facts.ancestorShas).toEqual(["aaa"]);
    expect(facts.squashedInto).toEqual({ bbb: "sss" });
    const { computeCommitFates } = await import("@centrail/parsers");
    const rows = computeCommitFates(facts);
    expect(rows.find((r) => r.sha === "bbb")).toEqual({ sha: "bbb", branch: "feature/x", fate: "shipped", mergedAs: "sss" });
    expect(git.squashedShas.mock.calls.map((c) => c[2]).sort()).toEqual(["refs/heads/feature/dead", "refs/heads/feature/x"]); // only branches with unmerged recent commits, never main or a merged one
  });
});

describe("runFatePass", () => {
  it("posts fates and tallies even when the server ignores the fates section", async () => {
    stubHappyRepo();
    // Old server: 2xx body has only attribution fields — no fates keys.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ linked: 0 }), { status: 200 }),
    );

    const tally = await runFatePass(AUTH, [{ root: "/repo", name: "repo" }], [], "install-1");
    expect(tally).toEqual({ shipped: 1, inFlight: 1, unshipped: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://centrail.org/api/cli/attribute");
    const body = JSON.parse((init as RequestInit).body as string);
    // Every fate row carries the commit's facts (§ 3.8): the server matches
    // events to commits from these, without a window, on any machine.
    // Every fate row carries the commit's facts (§ 3.8) and whether its
    // author is this machine's git identity (`mine`; the email never leaves;
    // absent when git has no author for the commit or no user.email).
    expect(body.fates).toEqual([
      { repoName: "repo", commitSha: "aaa", branch: "main", fate: "shipped", committedAt: daysAgo(1), linesAdded: 10, linesDeleted: 2, filesChanged: 3, mine: true },
      { repoName: "repo", commitSha: "bbb", branch: "feature/x", fate: "in_flight", committedAt: daysAgo(2), linesAdded: 0, linesDeleted: 0, filesChanged: 0, mine: false },
      { repoName: "repo", commitSha: "ccc", branch: "feature/dead", fate: "unshipped", committedAt: daysAgo(40), linesAdded: 7, linesDeleted: 7, filesChanged: 1 },
    ]);
    expect(body.repos).toEqual([]); // no repos passed: none declared
    expect(body.facts).toEqual({ machineId: "install-1", complete: true });
  });

  it("without a configured user.email no row claims `mine`", async () => {
    stubHappyRepo();
    git.readUserEmail.mockResolvedValue(null);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ linked: 0 }), { status: 200 }));
    await runFatePass(AUTH, [{ root: "/repo", name: "repo" }], [], "install-1");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.fates.every((f: { mine?: boolean }) => f.mine === undefined)).toBe(true);
  });

  it("one call per repo, each declaring only its own repo, so the server can tell which shas vanished from a complete set", async () => {
    stubHappyRepo();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ linked: 0 }), { status: 200 }));
    const declared = [
      { name: "repo", key: "github.com/acme/repo", totalLoc: 1, fileCount: 1 },
      { name: "other", key: "github.com/acme/other", totalLoc: 2, fileCount: 2 },
    ];
    await runFatePass(AUTH, [{ root: "/repo", name: "repo", key: "github.com/acme/repo" }, { root: "/other", name: "other", key: "github.com/acme/other" }], declared, "install-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string));
    expect(bodies.map((b) => b.repos)).toEqual([[declared[0]], [declared[1]]]);
    expect(bodies.every((b) => b.attributions.length === 0 && b.facts.machineId === "install-1" && b.facts.complete === true)).toBe(true);
    expect(bodies[1].fates.every((f: { repoKey: string }) => f.repoKey === "github.com/acme/other")).toBe(true);
  });

  it("a repo at the sha cap is sent in two calls and both say the set is incomplete, so the server vanishes nothing", async () => {
    git.resolveDefaultBranch.mockResolvedValue("main");
    git.readUserEmail.mockResolvedValue("me@example.com");
  git.resolveAncestryRef.mockResolvedValue("refs/heads/main");
  git.squashedShas.mockResolvedValue({});
    git.listRecentShas.mockResolvedValue(Array.from({ length: 2000 }, (_, i) => ({ sha: `s${i}`, committedAt: daysAgo(1), linesAdded: 1, linesDeleted: 0, filesChanged: 1 })));
    git.listBranchTips.mockResolvedValue([tip("main", daysAgo(0))]);
    git.listReachableShas.mockResolvedValue(Array.from({ length: 2000 }, (_, i) => `s${i}`));
    git.cherryEquivalentShas.mockResolvedValue([]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ linked: 0 }), { status: 200 }));
    const repos = [{ name: "repo", key: "github.com/acme/repo", totalLoc: 10, fileCount: 2 }];
    const tally = await runFatePass(AUTH, [{ root: "/repo", name: "repo", key: "github.com/acme/repo" }], repos, "install-1");
    expect(tally?.shipped).toBe(2000);
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string));
    expect(bodies.map((b) => b.fates.length)).toEqual([2000]);
    expect(bodies[0].repos).toEqual(repos);
    expect(bodies[0].facts).toEqual({ machineId: "install-1", complete: false });
  });

  it("survives a server that rejects the fates call (old server, non-2xx)", async () => {
    stubHappyRepo();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "unknown field fates" }), { status: 400 }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tally = await runFatePass(AUTH, [{ root: "/repo", name: "repo" }], [], "install-1");
    expect(tally).toEqual({ shipped: 1, inFlight: 1, unshipped: 1 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("survives a network failure", async () => {
    stubHappyRepo();
    fetchMock.mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tally = await runFatePass(AUTH, [{ root: "/repo", name: "repo" }], [], "install-1");
    expect(tally).toEqual({ shipped: 1, inFlight: 1, unshipped: 1 });
    warn.mockRestore();
  });

  it("returns null and never fetches when no repo has a resolvable default", async () => {
    git.resolveDefaultBranch.mockResolvedValue(null);
    const tally = await runFatePass(AUTH, [{ root: "/repo", name: "repo" }], [], "install-1");
    expect(tally).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

});

describe("formatShipStatusLine", () => {
  it("renders the pinned sync output line", () => {
    expect(formatShipStatusLine({ shipped: 3, inFlight: 1, unshipped: 2 })).toBe(
      "ship status: 3 shipped / 1 in flight / 2 unshipped",
    );
  });
});
