import { describe, expect, it } from "vitest";
import type { ParsedUsageEvent } from "@centrail/parsers";
import type { Config } from "./config.js";
import { toWireEvent, toWireUsageEvent } from "./wire.js";

describe("toWireUsageEvent", () => {
  it("uploads only the explicit usage allowlist", () => {
    const localEvent: ParsedUsageEvent = {
      externalId: "req_001",
      provider: "anthropic",
      model: "claude-fable-5-1",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      cacheWriteTokens: 40,
      cacheCreation5mTokens: 15,
      cacheCreation1hTokens: 25,
      occurredAt: new Date("2026-09-28T12:00:00.000Z"),
      metadata: {
        cwd: "/Users/private/company/secret-project",
        gitBranch: "person/secret-feature",
        sessionId: "session-private",
        version: "9.9.9",
        entrypoint: "private-client",
        origin: {
          host: "person-laptop",
          platform: "darwin",
          client: "private-client",
          clientVersion: "9.9.9",
        },
      },
    };

    expect(toWireUsageEvent(localEvent)).toEqual({
      externalId: "req_001",
      model: "claude-fable-5-1",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      cacheWriteTokens: 40,
      cacheCreation5mTokens: 15,
      cacheCreation1hTokens: 25,
      occurredAt: "2026-09-28T12:00:00.000Z",
    });

    const json = JSON.stringify(toWireUsageEvent(localEvent));
    for (const privateValue of [
      "anthropic",
      "/Users/private",
      "secret-feature",
      "session-private",
      "person-laptop",
      "darwin",
      "private-client",
    ]) {
      expect(json).not.toContain(privateValue);
    }
  });

  it("preserves an unfamiliar future model name without an allowlist", () => {
    const event = {
      externalId: "future-1",
      provider: "unknown",
      model: "vendor-model-next-2099",
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      occurredAt: new Date("2026-09-28T12:00:00.000Z"),
      metadata: {},
    } satisfies ParsedUsageEvent;

    expect(toWireUsageEvent(event).model).toBe("vendor-model-next-2099");
  });
});

const base: ParsedUsageEvent = {
  externalId: "req_1",
  provider: "anthropic",
  model: "claude-opus-4-8",
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheCreationTokens: 4,
  cacheCreation5mTokens: 4,
  cacheCreation1hTokens: 0,
  occurredAt: new Date("2026-06-01T00:00:00Z"),
  metadata: {
    cwd: "/Users/jane/work/repo",
    gitBranch: "feature/x",
    sessionId: "s1",
    version: "2.0.0",
    entrypoint: "cli",
    repo: { key: "github.com/acme/repo", label: "repo", source: "remote" },
    origin: { host: "janes-mbp", platform: "darwin", client: "cli", clientVersion: "2.0.0" },
  },
};
const cfg: Config = {
  installId: "i",
  mode: "all",
  allowRepos: [],
  denyRepos: [],
  surfaces: {},
  scopeDecidedAt: null,
  pendingBackfill: false,
  hideRepoNames: false,
  hideBranchNames: false,
};
const legacy = { fields: new Set<string>() };
const aware = { fields: new Set(["repo"]) };

describe("toWireEvent", () => {
  it("against a server that does not list \"repo\": the 0.5.1 allowlist exactly, no metadata", () => {
    expect(toWireEvent(base, legacy, cfg, "install-1")).toEqual(toWireUsageEvent(base));
  });

  it("against an identity-aware server: repo, session, branch and install id ship; path, host, platform, client do not", () => {
    const w = toWireEvent(base, aware, cfg, "install-1");
    expect(w.metadata).toEqual({
      repo: { key: "github.com/acme/repo", label: "repo", source: "remote" },
      sessionId: "s1",
      gitBranch: "feature/x",
      origin: { machineId: "install-1" },
    });
    for (const local of ["janes-mbp", "/Users/jane", "darwin", "2.0.0"]) {
      expect(JSON.stringify(w)).not.toContain(local);
    }
  });

  it("hideBranchNames drops the branch; hideRepoNames hashes the key and blanks the label", () => {
    const w = toWireEvent(
      base,
      aware,
      { ...cfg, hideBranchNames: true, hideRepoNames: true },
      "install-1",
    ) as { metadata: { gitBranch?: string; repo: { key: string; label: string } } };
    expect(w.metadata.gitBranch).toBeUndefined();
    expect(w.metadata.repo.key).toMatch(/^hidden:[0-9a-f]{16}$/);
    expect(w.metadata.repo.label).toBe("");
    expect(JSON.stringify(w)).not.toContain("acme");
  });
});
