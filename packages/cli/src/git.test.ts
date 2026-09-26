import { beforeEach, describe, expect, it, vi } from "vitest";

// git.ts builds its runner with promisify(execFile); mocking the
// promisify.custom hook on execFile makes `exec` resolve/reject through
// execMock without touching a real repo.
const execMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = vi.fn() as unknown as Record<PropertyKey, unknown>;
  execFile[promisify.custom] = execMock;
  return { execFile };
});

import {
  cherryEquivalentShas,
  gitEnv,
  listBranchTips,
  listReachableShas,
  listRecentShas,
  RECENT_SHA_CAP,
  resolveDefaultBranch,
} from "./git.js";

const ROOT = "/repo";

// Route mock calls by git subcommand; unrouted commands reject like git would.
function routeGit(routes: Record<string, string | Error>): void {
  execMock.mockImplementation((_cmd: string, args: string[]) => {
    const sub = args[2]; // ["-C", root, <subcommand>, ...]
    const key = Object.keys(routes).find((k) => {
      const [wantSub, ...wantArgs] = k.split(" ");
      return sub === wantSub && wantArgs.every((a) => args.includes(a));
    });
    if (key === undefined) return Promise.reject(new Error(`no route: ${args.join(" ")}`));
    const out = routes[key];
    if (out instanceof Error) return Promise.reject(out);
    return Promise.resolve({ stdout: out, stderr: "" });
  });
}

beforeEach(() => {
  execMock.mockReset();
});

describe("resolveDefaultBranch", () => {
  it("uses origin/HEAD stripped of its origin/ prefix when the local head verifies", async () => {
    routeGit({
      "symbolic-ref": "origin/main\n",
      "rev-parse refs/heads/main": "abc\n",
    });
    expect(await resolveDefaultBranch(ROOT)).toBe("main");
  });

  it("falls back to main/master when origin/HEAD is unset", async () => {
    routeGit({
      "symbolic-ref": new Error("no origin HEAD"),
      "rev-parse --abbrev-ref": "feature/x\n",
      "rev-parse refs/heads/master": "abc\n",
      "rev-parse refs/heads/feature/x": "def\n",
    });
    expect(await resolveDefaultBranch(ROOT)).toBe("master");
  });

  it("falls back to the current branch when neither main nor master exist", async () => {
    routeGit({
      "symbolic-ref": new Error("no origin HEAD"),
      "rev-parse --abbrev-ref": "trunk\n",
      "rev-parse refs/heads/trunk": "abc\n",
    });
    expect(await resolveDefaultBranch(ROOT)).toBe("trunk");
  });

  it("returns null when nothing resolves (fate pass must skip, never guess)", async () => {
    routeGit({});
    expect(await resolveDefaultBranch(ROOT)).toBeNull();
  });

  it("returns null on a detached HEAD with no main/master", async () => {
    routeGit({
      "symbolic-ref": new Error("no origin HEAD"),
      "rev-parse --abbrev-ref": "HEAD\n",
    });
    expect(await resolveDefaultBranch(ROOT)).toBeNull();
  });
});

describe("listRecentShas", () => {
  const rec = (sha: string, iso: string, files: string[] = []) => `\x1e${sha}\x1f${iso}\n${files.join("\n")}${files.length ? "\n" : ""}`;

  it("parses one numstat record per commit from git log --all: sha, date and line counts (§ 3.8 facts)", async () => {
    routeGit({
      log: rec("aaa", "2026-07-20T10:00:00+00:00", ["3\t1\tsrc/a.ts", "-\t-\timg.png"]) + rec("bbb", "2026-07-19T09:00:00+00:00"),
    });
    expect(await listRecentShas(ROOT)).toEqual([
      { sha: "aaa", committedAt: "2026-07-20T10:00:00.000Z", linesAdded: 3, linesDeleted: 1, filesChanged: 2 },
      { sha: "bbb", committedAt: "2026-07-19T09:00:00.000Z", linesAdded: 0, linesDeleted: 0, filesChanged: 0 },
    ]);
    const args = execMock.mock.calls[0][1] as string[];
    expect(args).toContain("--all");
    expect(args).toContain("--since=90 days ago");
    expect(args).toContain("--numstat");
  });

  it("caps output at RECENT_SHA_CAP and skips malformed records", async () => {
    const records = Array.from({ length: RECENT_SHA_CAP + 50 }, (_, i) => rec(`sha${i}`, "2026-07-01T00:00:00+00:00"));
    routeGit({ log: `garbage-line\n\x1enot-a-record\n${records.join("")}` });
    const shas = await listRecentShas(ROOT);
    expect(shas).toHaveLength(RECENT_SHA_CAP);
    expect(shas[0].sha).toBe("sha0");
  });

  it("returns [] when git fails", async () => {
    routeGit({});
    expect(await listRecentShas(ROOT)).toEqual([]);
  });
});

describe("cherryEquivalentShas", () => {
  it("returns only the '-' (already-on-default) shas", async () => {
    routeGit({ cherry: "- aaa111\n+ bbb222\n- ccc333\n" });
    expect(await cherryEquivalentShas(ROOT, "main", "feature/x")).toEqual([
      "aaa111",
      "ccc333",
    ]);
  });

  it("returns [] when git cherry fails", async () => {
    routeGit({});
    expect(await cherryEquivalentShas(ROOT, "main", "feature/x")).toEqual([]);
  });
});

describe("listBranchTips", () => {
  it("parses one for-each-ref line per branch, dropping symrefs and origin noise", async () => {
    routeGit({
      "for-each-ref": [
        "refs/heads/main\x1fmain\x1faaa\x1f2026-07-20T10:00:00+00:00\x1f",
        "refs/heads/feature/x\x1ffeature/x\x1fbbb\x1f2026-07-19T09:00:00+00:00\x1f",
        "refs/remotes/origin/HEAD\x1forigin/HEAD\x1faaa\x1f2026-07-20T10:00:00+00:00\x1frefs/remotes/origin/main",
        "refs/remotes/origin/main\x1forigin/main\x1faaa\x1f2026-07-20T10:00:00+00:00\x1f",
        "",
      ].join("\n"),
    });
    expect(await listBranchTips(ROOT)).toEqual([
      { ref: "refs/heads/main", name: "main", sha: "aaa", tipDate: "2026-07-20T10:00:00+00:00" },
      { ref: "refs/heads/feature/x", name: "feature/x", sha: "bbb", tipDate: "2026-07-19T09:00:00+00:00" },
      { ref: "refs/remotes/origin/main", name: "origin/main", sha: "aaa", tipDate: "2026-07-20T10:00:00+00:00" },
    ]);
  });

  it("returns [] when git fails", async () => {
    routeGit({});
    expect(await listBranchTips(ROOT)).toEqual([]);
  });
});

describe("listReachableShas", () => {
  it("lists shas from rev-list with the window and the full ref, ending in --", async () => {
    routeGit({ "rev-list": "aaa\nbbb\n\n" });
    expect(await listReachableShas(ROOT, "refs/heads/main")).toEqual(["aaa", "bbb"]);
    const args = execMock.mock.calls[0][1] as string[];
    expect(args).toContain("--since=90 days ago");
    expect(args.slice(-2)).toEqual(["refs/heads/main", "--"]);
  });

  it("returns [] when git fails", async () => {
    routeGit({});
    expect(await listReachableShas(ROOT, "refs/heads/gone")).toEqual([]);
  });
});

describe("gitEnv", () => {
  it("drops every repo-redirecting variable and disables optional locks", () => {
    const env = gitEnv({ PATH: "/bin", GIT_DIR: "/elsewhere/.git", GIT_WORK_TREE: "/x", HOME: "/h" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", GIT_OPTIONAL_LOCKS: "0" });
  });
});
