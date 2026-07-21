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
  branchTipDate,
  branchesContaining,
  cherryEquivalentShas,
  isAncestor,
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
  it("parses sha\\x1fdate lines from git log --all", async () => {
    routeGit({
      log: "aaa\x1f2026-07-20T10:00:00+00:00\nbbb\x1f2026-07-19T09:00:00+00:00\n",
    });
    expect(await listRecentShas(ROOT)).toEqual([
      { sha: "aaa", committedAt: "2026-07-20T10:00:00+00:00" },
      { sha: "bbb", committedAt: "2026-07-19T09:00:00+00:00" },
    ]);
    const args = execMock.mock.calls[0][1] as string[];
    expect(args).toContain("--all");
    expect(args).toContain("--since=90 days ago");
  });

  it("caps output at RECENT_SHA_CAP and skips malformed lines", async () => {
    const lines = Array.from(
      { length: RECENT_SHA_CAP + 50 },
      (_, i) => `sha${i}\x1f2026-07-01T00:00:00+00:00`,
    );
    routeGit({ log: `garbage-line\n${lines.join("\n")}\n` });
    const shas = await listRecentShas(ROOT);
    expect(shas).toHaveLength(RECENT_SHA_CAP);
    expect(shas[0].sha).toBe("sha0");
  });

  it("returns [] when git fails", async () => {
    routeGit({});
    expect(await listRecentShas(ROOT)).toEqual([]);
  });
});

describe("isAncestor", () => {
  it("maps exit 0 to true and any failure to false", async () => {
    routeGit({ "merge-base": "" });
    expect(await isAncestor(ROOT, "aaa", "main")).toBe(true);
    routeGit({ "merge-base": new Error("exit 1") });
    expect(await isAncestor(ROOT, "aaa", "main")).toBe(false);
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

describe("branchesContaining", () => {
  it("returns short names, dropping detached-HEAD and origin/HEAD noise", async () => {
    routeGit({
      branch: "(HEAD detached at abc123)\nmain\norigin\norigin/HEAD\norigin/main\nfeature/x\n\n",
    });
    expect(await branchesContaining(ROOT, "aaa")).toEqual([
      "main",
      "origin/main",
      "feature/x",
    ]);
  });

  it("returns [] when git fails", async () => {
    routeGit({});
    expect(await branchesContaining(ROOT, "aaa")).toEqual([]);
  });
});

describe("branchTipDate", () => {
  it("returns the tip committer date", async () => {
    routeGit({ log: "2026-07-20T10:00:00+00:00\n" });
    expect(await branchTipDate(ROOT, "feature/x")).toBe("2026-07-20T10:00:00+00:00");
  });

  it("returns null for unknown refs or empty output", async () => {
    routeGit({ log: "" });
    expect(await branchTipDate(ROOT, "gone")).toBeNull();
    routeGit({});
    expect(await branchTipDate(ROOT, "gone")).toBeNull();
  });
});
