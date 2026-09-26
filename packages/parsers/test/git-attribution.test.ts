import { describe, expect, it } from "vitest";
import {
  matchEventsToCommits,
  parseGitLogNumstat,
  type AttributionEvent,
  type RepoCommit,
} from "../src/index.js";

// `git log --numstat --pretty=format:%x1e%H%x1f%cI` output. \x1e starts each
// record; \x1f splits sha from ISO date; numstat lines follow.
const RS = "\x1e";
const US = "\x1f";
const gitLog =
  `${RS}aaa111${US}2026-06-01T10:00:00+00:00\n` +
  `10\t2\tsrc/a.ts\n` +
  `5\t0\tsrc/b.ts\n` +
  `${RS}bbb222${US}2026-06-01T12:00:00+00:00\n` +
  `-\t-\tassets/logo.png\n` + // binary file: counts as 0/0 but 1 file
  `3\t1\tsrc/c.ts\n`;

describe("parseGitLogNumstat", () => {
  it("parses commits with summed numstat and file counts", () => {
    const commits = parseGitLogNumstat(gitLog);
    expect(commits).toHaveLength(2);
    expect(commits[0].sha).toBe("aaa111");
    expect(commits[0].committedAt.toISOString()).toBe(
      "2026-06-01T10:00:00.000Z",
    );
    expect(commits[0].linesAdded).toBe(15);
    expect(commits[0].linesDeleted).toBe(2);
    expect(commits[0].filesChanged).toBe(2);
    // Binary "-" counts as 0 lines but still a changed file.
    expect(commits[1].linesAdded).toBe(3);
    expect(commits[1].filesChanged).toBe(2);
  });

  it("returns [] for empty output", () => {
    expect(parseGitLogNumstat("")).toEqual([]);
  });
});

describe("matchEventsToCommits", () => {
  const commits: RepoCommit[] = [
    { sha: "aaa111", committedAt: new Date("2026-06-01T10:00:00Z"), linesAdded: 15, linesDeleted: 2, filesChanged: 2 },
    { sha: "bbb222", committedAt: new Date("2026-06-01T12:00:00Z"), linesAdded: 3, linesDeleted: 1, filesChanged: 2 },
  ];
  const ev = (externalId: string, iso: string): AttributionEvent => ({
    externalId,
    occurredAt: new Date(iso),
  });

  it("attributes an event to the earliest commit at or after it", () => {
    // 09:30 -> falls into the window ending at the 10:00 commit
    const out = matchEventsToCommits([ev("e1", "2026-06-01T09:30:00Z")], commits);
    expect(out).toHaveLength(1);
    expect(out[0].externalId).toBe("e1");
    expect(out[0].sha).toBe("aaa111");
  });

  it("attributes a between-commits event to the next commit", () => {
    // 11:00 is after aaa111 (10:00), at/before bbb222 (12:00) -> bbb222
    const out = matchEventsToCommits([ev("e2", "2026-06-01T11:00:00Z")], commits);
    expect(out[0].sha).toBe("bbb222");
  });

  it("leaves events newer than the last commit unattributed (WIP)", () => {
    const out = matchEventsToCommits([ev("e3", "2026-06-01T13:00:00Z")], commits);
    expect(out).toEqual([]);
  });

  it("handles an exact-timestamp match (<=) by attributing to that commit", () => {
    const out = matchEventsToCommits([ev("e4", "2026-06-01T10:00:00Z")], commits);
    expect(out[0].sha).toBe("aaa111");
  });

  it("returns [] when there are no commits", () => {
    expect(matchEventsToCommits([ev("e5", "2026-06-01T10:00:00Z")], [])).toEqual([]);
  });

  it("two commits at the same second tie-break on sha, whatever order they arrive in", () => {
    // Same-second commits are real (a script, a fixture, `git commit` twice
    // fast); the server matches over rows in no promised order, so input
    // order must not decide.
    const at = new Date("2026-06-01T00:00:10Z");
    const a = { sha: "aaaa", committedAt: at, linesAdded: 1, linesDeleted: 0, filesChanged: 1 };
    const b = { sha: "bbbb", committedAt: at, linesAdded: 2, linesDeleted: 0, filesChanged: 1 };
    const ev = [{ externalId: "e", occurredAt: new Date("2026-06-01T00:00:00Z") }];
    expect(matchEventsToCommits(ev, [b, a])[0].sha).toBe("aaaa");
    expect(matchEventsToCommits(ev, [a, b])[0].sha).toBe("aaaa");
  });
});
