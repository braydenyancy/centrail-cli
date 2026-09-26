import type { ParsedUsageEvent, RepoIdentity } from "@centrail/parsers";
import { describe, expect, it } from "vitest";
import { parseConfig, type Config } from "./config.js";
import { eventInScope, parseSelection, renderRepoRows, repoStatus, summarizeRepos, surfaceEnabled } from "./scope.js";

const base: Config = parseConfig({});
const acme = { key: "github.com/acme/api", label: "api", source: "remote" as const };
const web = { key: "github.com/acme/web", label: "web", source: "remote" as const };

function ev(repo: RepoIdentity | undefined, sessionId = "s", at = "2026-06-01T00:00:00Z"): ParsedUsageEvent {
  return {
    externalId: `${sessionId}-${Math.random()}`,
    provider: "anthropic",
    model: "m",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    occurredAt: new Date(at),
    metadata: { repo, sessionId },
  };
}

describe("scope", () => {
  it("mode all: everything syncs except excluded, by key or by label", () => {
    expect(repoStatus(acme, base)).toBe("synced");
    expect(repoStatus(undefined, base)).toBe("synced");
    expect(repoStatus(acme, { ...base, denyRepos: ["github.com/acme/api"] })).toBe("excluded");
    expect(repoStatus(acme, { ...base, denyRepos: ["api"] })).toBe("excluded");
    expect(eventInScope(ev(web), { ...base, denyRepos: ["api"] })).toBe(true);
  });

  it("mode allow: only listed repos sync; unknown and unidentified wait; exclude still wins", () => {
    const cfg: Config = { ...base, mode: "allow", allowRepos: ["github.com/acme/api"] };
    expect(repoStatus(acme, cfg)).toBe("synced");
    expect(repoStatus(web, cfg)).toBe("waiting");
    expect(repoStatus(undefined, cfg)).toBe("waiting");
    expect(repoStatus(acme, { ...cfg, denyRepos: ["api"] })).toBe("excluded");
  });

  it("surfaces default on; only an explicit false turns one off", () => {
    expect(surfaceEnabled(base, "codex")).toBe(true);
    expect(surfaceEnabled({ ...base, surfaces: { codex: false } }, "codex")).toBe(false);
    expect(surfaceEnabled({ ...base, surfaces: { codex: false } }, "claude-code")).toBe(true);
  });

  it("summarizeRepos: one row per key, labels merged, sessions counted, sorted by events", () => {
    const wt = { ...acme, label: "api-wt" };
    const rows = summarizeRepos([ev(acme, "a"), ev(wt, "b"), ev(acme, "a"), ev(web, "c"), ev(undefined, "d")]);
    expect(rows.map((r) => r.key)).toEqual(["github.com/acme/api", "github.com/acme/web"]);
    expect(rows[0]).toMatchObject({ labels: ["api", "api-wt"], sessions: 2, events: 3 });
    const lines = renderRepoRows(rows, { ...base, denyRepos: ["web"] });
    expect(lines[0]).toContain("✓ github.com/acme/api");
    expect(lines[1]).toContain("✗ github.com/acme/web");
  });

  it("parseSelection: exclusions, `only`, garbage", () => {
    expect(parseSelection("2, 5 7", 10)).toEqual({ mode: "all", picks: [1, 4, 6] });
    expect(parseSelection("only 1,3", 10)).toEqual({ mode: "allow", picks: [0, 2] });
    expect(parseSelection("0, 11, x", 10)).toBeNull();
    expect(parseSelection("", 10)).toBeNull();
  });

  it("parseConfig: defaults, and an old 0.5 file upgrades in place", () => {
    expect(parseConfig(null)).toMatchObject({ mode: "all", allowRepos: [], denyRepos: [], surfaces: {}, scopeDecidedAt: null });
    expect(parseConfig({ denyRepos: ["api", 3], mode: "nonsense", surfaces: { codex: false, x: "no" } })).toMatchObject({
      mode: "all",
      denyRepos: ["api"],
      surfaces: { codex: false },
    });
  });

  // The full decision table. `wt` is a second worktree of acme (same key,
  // different label): whatever is decided for acme must hold for it.
  const wt = { ...acme, label: "api-feature" };
  const shaRepo = { key: "sha:" + "a".repeat(40), label: "local", source: "root" as const };
  const folder = { key: "dir:0123456789abcdef", label: "scratch", source: "folder" as const };
  it.each([
    ["all, nothing listed", "all", [], [], acme, "synced"],
    ["all, excluded by key — worktree too", "all", [], ["github.com/acme/api"], wt, "excluded"],
    ["all, excluded by label — only that basename", "all", [], ["api"], wt, "synced"],
    ["all, excluded by label — that basename", "all", [], ["api"], acme, "excluded"],
    ["all, excluded by a sha key", "all", [], [shaRepo.key], shaRepo, "excluded"],
    ["all, excluded by a dir key", "all", [], [folder.key], folder, "excluded"],
    ["all, an empty string in the list matches nothing", "all", [], [""], { ...acme, label: "" }, "synced"],
    ["all, unidentified event", "all", [], ["api"], undefined, "synced"],
    ["allow, listed by key — worktree too", "allow", ["github.com/acme/api"], [], wt, "synced"],
    ["allow, listed by label — only that basename", "allow", ["api"], [], wt, "waiting"],
    ["allow, not listed", "allow", ["github.com/acme/web"], [], acme, "waiting"],
    ["allow, listed AND excluded → excluded wins", "allow", ["github.com/acme/api"], ["api"], acme, "excluded"],
    ["allow, unidentified event waits", "allow", ["github.com/acme/api"], [], undefined, "waiting"],
    ["allow, empty allow list holds everything", "allow", [], [], acme, "waiting"],
  ] as const)("%s", (_, mode, allowRepos, denyRepos, repo, expected) => {
    const cfg: Config = { ...base, mode, allowRepos: [...allowRepos], denyRepos: [...denyRepos] };
    expect(repoStatus(repo, cfg)).toBe(expected);
    expect(eventInScope(ev(repo), cfg)).toBe(expected === "synced");
  });
});
