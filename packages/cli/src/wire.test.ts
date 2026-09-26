import { describe, expect, it, vi } from "vitest";
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

  it.each([
    ["identity-aware", ["repo"], true],
    ["0.5-era", [], false],
  ])("%s server: the placement tag travels with the identity and only then; touched paths and turn ids never leave", (_, fields, aware) => {
    const e: ParsedUsageEvent = { ...base, metadata: { ...base.metadata, placement: "files", turn: "s1#3", touched: { writes: ["/Users/jane/work/repo/x.ts"], reads: ["/Users/jane/work/other"] } } };
    const wire = toWireEvent(e, { fields: new Set(fields) }, cfg, "install");
    const metadata = wire.metadata as Record<string, unknown>;
    expect(metadata.placement).toBe(aware ? "files" : undefined);
    expect(metadata.touched).toBeUndefined();
    expect(metadata.turn).toBeUndefined();
    expect(JSON.stringify(wire)).not.toContain("/Users/jane/work/other");
    if (aware) expect(JSON.stringify(wire)).not.toContain("/Users/jane");
  });

  it("no placement without an identity, and a hidden identity keeps its tag", () => {
    const bare: ParsedUsageEvent = { ...base, metadata: { ...base.metadata, repo: undefined, placement: "files" } };
    expect((toWireEvent(bare, { fields: new Set(["repo"]) }, cfg, "i").metadata as Record<string, unknown>).placement).toBeUndefined();
    const hidden: ParsedUsageEvent = { ...base, metadata: { ...base.metadata, placement: "sticky" } };
    const m = toWireEvent(hidden, { fields: new Set(["repo"]) }, { ...cfg, hideRepoNames: true }, "i").metadata as Record<string, unknown>;
    expect(m.placement).toBe("sticky");
    expect((m.repo as { key: string }).key).toMatch(/^hidden:/);
  });

  it.each([
    ["a 503", async () => new Response("{}", { status: 503 })],
    ["a network failure", async () => { throw new Error("ECONNREFUSED"); }],
    ["a timeout", async () => { throw new DOMException("aborted", "TimeoutError"); }],
  ])("readCapabilities on %s keeps what the server said last; with nothing known it is the 0.5 wire", async (_, impl) => {
    const { readCapabilities } = await import("./wire.js");
    const fetchMock = vi.fn(impl);
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect([...(await readCapabilities({ baseUrl: "https://x" }, { fields: new Set(["repo", "match"]) })).fields]).toEqual(["repo", "match"]);
      expect([...(await readCapabilities({ baseUrl: "https://x" })).fields]).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("readCapabilities trusts an answering server over the cache, even when it advertises less", async () => {
    const { readCapabilities } = await import("./wire.js");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ fields: [] }), { status: 200 })));
    try {
      expect([...(await readCapabilities({ baseUrl: "https://x" }, { fields: new Set(["repo"]) })).fields]).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["a server with usage-extras", ["repo", "usage-extras"], { speed: "fast", webSearchRequests: 2 }],
    ["an identity-aware server without it", ["repo"], {}],
    ["a 0.5-era server", [], {}],
  ])("usage extras reach %s only when advertised", (_, fields, expected) => {
    const e: ParsedUsageEvent = { ...base, speed: "fast", webSearchRequests: 2 };
    const wire = toWireEvent(e, { fields: new Set(fields) }, cfg, "i");
    expect({ speed: wire.speed, webSearchRequests: wire.webSearchRequests }).toEqual({ speed: undefined, webSearchRequests: undefined, ...expected });
  });
});

