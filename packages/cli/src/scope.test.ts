import type { ParsedUsageEvent } from "@centrail/parsers";
import { describe, expect, it } from "vitest";
import { parseConfig, type Config } from "./config.js";
import { eventInScope, parseSelection, renderRepoRows, repoStatus, summarizeRepos, surfaceEnabled } from "./scope.js";

const base: Config = parseConfig({});
const acme = { key: "github.com/acme/api", label: "api", source: "remote" as const };
const web = { key: "github.com/acme/web", label: "web", source: "remote" as const };

function ev(repo: typeof acme | undefined, sessionId = "s", at = "2026-06-01T00:00:00Z"): ParsedUsageEvent {
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
});
