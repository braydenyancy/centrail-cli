import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const git = vi.hoisted(() => ({
  resolveDefaultBranch: vi.fn(),
  listRecentShas: vi.fn(),
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
  git.listRecentShas.mockResolvedValue([
    { sha: "aaa", committedAt: daysAgo(1) },
    { sha: "bbb", committedAt: daysAgo(2) },
    { sha: "ccc", committedAt: daysAgo(40) },
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
  for (const fn of Object.values(git)) fn.mockReset();
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

describe("runFatePass", () => {
  it("posts fates and tallies even when the server ignores the fates section", async () => {
    stubHappyRepo();
    // Old server: 2xx body has only attribution fields — no fates keys.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ linked: 0 }), { status: 200 }),
    );

    const tally = await runFatePass(AUTH, [{ root: "/repo", name: "repo" }]);
    expect(tally).toEqual({ shipped: 1, inFlight: 1, unshipped: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://centrail.org/api/cli/attribute");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.fates).toEqual([
      { repoName: "repo", commitSha: "aaa", branch: "main", fate: "shipped" },
      { repoName: "repo", commitSha: "bbb", branch: "feature/x", fate: "in_flight" },
      { repoName: "repo", commitSha: "ccc", branch: "feature/dead", fate: "unshipped" },
    ]);
  });

  it("survives a server that rejects the fates call (old server, non-2xx)", async () => {
    stubHappyRepo();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "unknown field fates" }), { status: 400 }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tally = await runFatePass(AUTH, [{ root: "/repo", name: "repo" }]);
    expect(tally).toEqual({ shipped: 1, inFlight: 1, unshipped: 1 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("survives a network failure", async () => {
    stubHappyRepo();
    fetchMock.mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tally = await runFatePass(AUTH, [{ root: "/repo", name: "repo" }]);
    expect(tally).toEqual({ shipped: 1, inFlight: 1, unshipped: 1 });
    warn.mockRestore();
  });

  it("returns null and never fetches when no repo has a resolvable default", async () => {
    git.resolveDefaultBranch.mockResolvedValue(null);
    const tally = await runFatePass(AUTH, [{ root: "/repo", name: "repo" }]);
    expect(tally).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("chunks fates at 2000 per call", async () => {
    git.resolveDefaultBranch.mockResolvedValue("main");
    git.listRecentShas.mockResolvedValue(
      Array.from({ length: 2001 }, (_, i) => ({
        sha: `s${i}`,
        committedAt: daysAgo(1),
      })),
    );
    git.listBranchTips.mockResolvedValue([tip("main", daysAgo(0))]);
    git.listReachableShas.mockResolvedValue(
      Array.from({ length: 2001 }, (_, i) => `s${i}`),
    );
    git.cherryEquivalentShas.mockResolvedValue([]);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ linked: 0 }), { status: 200 }),
    );

    const tally = await runFatePass(AUTH, [{ root: "/repo", name: "repo" }]);
    expect(tally?.shipped).toBe(2001);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(firstBody.fates).toHaveLength(2000);
    expect(secondBody.fates).toHaveLength(1);
  });
});

describe("formatShipStatusLine", () => {
  it("renders the pinned sync output line", () => {
    expect(formatShipStatusLine({ shipped: 3, inFlight: 1, unshipped: 2 })).toBe(
      "ship status: 3 shipped / 1 in flight / 2 unshipped",
    );
  });
});
