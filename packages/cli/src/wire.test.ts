import { describe, expect, it, vi } from "vitest";
import type { ParsedUsageEvent } from "@centrail/parsers";
import type { Config } from "./config.js";
import { toWireEvent, toWireFate, toWireUsageEvent, type LocalFate } from "./wire.js";

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
    const metadata = (wire.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.placement).toBe(aware ? "files" : undefined);
    expect(metadata.touched).toBeUndefined();
    expect(metadata.turn).toBeUndefined();
    expect(JSON.stringify(wire)).not.toContain("/Users/jane/work/other");
    expect(JSON.stringify(wire)).not.toContain("/Users/jane");
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


// The allowlist, pinned. A parsed event stuffed with everything the machine
// knows — paths, hostname, platform, client, account, prompt and code text,
// a diff, a commit message, a Copilot blob, fields no parser has today —
// must come out as exactly the named keys, at every level, for a server
// that lists nothing and for one that lists every 0.6 field. A field that
// reaches the wire by spreading, or by being added to the parsed event,
// fails here.
describe("the wire allowlist", () => {
  const ROOT = "0123456789abcdef0123456789abcdef01234567";
  const SECRETS = [
    "/Users/jane", "janes-mbp", "darwin", "claude-vscode", "9.9.9", "jane@acme.com",
    "org-uuid-1", "acct-uuid-1", "PROMPT-TEXT", "CODE-TEXT", "DIFF-TEXT", "COMMIT-MESSAGE",
    "ENCRYPTED-BLOB", "anthropic", "turn-7", "touched-file.ts",
  ];
  const stuffed = (): ParsedUsageEvent =>
    ({
      ...base,
      cacheWriteTokens: 4,
      speed: "fast",
      webSearchRequests: 3,
      prompt: "PROMPT-TEXT",
      content: "CODE-TEXT",
      diff: "DIFF-TEXT",
      encrypted_content: "ENCRYPTED-BLOB",
      metadata: {
        cwd: "/Users/jane/work/repo",
        gitBranch: "feature/x",
        sessionId: "s1",
        version: "9.9.9",
        entrypoint: "claude-vscode",
        isSidechain: false,
        messageId: "msg_1",
        fallback: true,
        turn: "turn-7",
        touched: { writes: ["/Users/jane/work/repo/touched-file.ts"], reads: [] },
        placement: "files",
        repo: { key: "github.com/acme/repo", label: "repo", source: "remote", root: ROOT, path: "/Users/jane/work/repo" },
        origin: { host: "janes-mbp", platform: "darwin", client: "claude-vscode", clientVersion: "9.9.9" },
        account: { emailAddress: "jane@acme.com", organizationUuid: "org-uuid-1", accountUuid: "acct-uuid-1" },
        commitMessage: "COMMIT-MESSAGE",
      },
    }) as unknown as ParsedUsageEvent;

  const keysDeep = (v: unknown, prefix = ""): string[] =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.entries(v).flatMap(([k, x]) => [`${prefix}${k}`, ...keysDeep(x, `${prefix}${k}.`)])
      : [];

  const USAGE_KEYS = [
    "externalId", "model", "inputTokens", "outputTokens", "cacheReadTokens",
    "cacheCreationTokens", "cacheWriteTokens", "cacheCreation5mTokens", "cacheCreation1hTokens", "occurredAt",
  ];

  it.each([
    ["lists nothing (0.5.1-era)", [], USAGE_KEYS],
    ["lists only \"match\"", ["match"], USAGE_KEYS],
    ["lists \"usage-extras\" only", ["usage-extras"], [...USAGE_KEYS, "speed", "webSearchRequests"]],
    [
      "lists every 0.6 field",
      ["repo", "match", "usage-extras"],
      [
        ...USAGE_KEYS, "speed", "webSearchRequests",
        "metadata", "metadata.repo", "metadata.repo.key", "metadata.repo.label", "metadata.repo.source", "metadata.repo.root",
        "metadata.placement", "metadata.sessionId", "metadata.gitBranch", "metadata.origin", "metadata.origin.machineId",
      ],
    ],
  ])("a server that %s gets exactly the allowed keys, nothing local", (_, fields, allowed) => {
    const wire = toWireEvent(stuffed(), { fields: new Set(fields) }, cfg, "3f0c2a8e-7d1b-4c55-9a3e-2b8f6d4e1c90");
    expect(keysDeep(wire).sort()).toEqual([...allowed].sort());
    const json = JSON.stringify(wire);
    for (const secret of SECRETS) expect(json).not.toContain(secret);
    if (fields.includes("repo")) {
      expect(wire.metadata).toEqual({
        repo: { key: "github.com/acme/repo", label: "repo", source: "remote", root: ROOT },
        placement: "files",
        sessionId: "s1",
        gitBranch: "feature/x",
        origin: { machineId: "3f0c2a8e-7d1b-4c55-9a3e-2b8f6d4e1c90" },
      });
    }
  });

  it("hideRepoNames withholds the root sha with the name: a hidden repo cannot be joined back by its first commit", () => {
    const wire = toWireEvent(stuffed(), { fields: new Set(["repo"]) }, { ...cfg, hideRepoNames: true }, "i");
    expect(Object.keys(wire.metadata!.repo!).sort()).toEqual(["key", "label", "source"]);
    expect(JSON.stringify(wire)).not.toContain(ROOT);
  });
});

// The fate-row allowlist, pinned the same way. A fate stuffed with
// everything the fate pass holds locally — the author's address, paths,
// the diff and message, fields no gatherer has today — must come out as
// exactly the named keys for each capability set. Old servers keep exactly
// today's rows: the 0.5.1 four, or those plus the "repo" facts.
describe("the fate-row allowlist", () => {
  const SHA = "1111111111111111111111111111111111111111";
  const SQUASH = "2222222222222222222222222222222222222222";
  const PATCH = "3333333333333333333333333333333333333333";
  const BRANCH_PATCH = "4444444444444444444444444444444444444444";
  const SECRETS = ["jane@acme.com", "/Users/jane", "janes-mbp", "DIFF-TEXT", "COMMIT-MESSAGE", "refs/heads/feature/x"];
  const stuffedFate = (): LocalFate =>
    ({
      repoName: "repo",
      repoKey: "github.com/acme/repo",
      row: { sha: SHA, branch: "feature/x", fate: "shipped", mergedAs: SQUASH, cwd: "/Users/jane/work/repo", message: "COMMIT-MESSAGE" },
      commit: {
        sha: SHA, committedAt: "2026-09-30T12:00:00.000Z", linesAdded: 3, linesDeleted: 1, filesChanged: 2,
        authorEmail: "jane@acme.com", diff: "DIFF-TEXT", subject: "COMMIT-MESSAGE", host: "janes-mbp",
      },
      mine: true,
      patchId: PATCH,
      branchPatchId: BRANCH_PATCH,
      root: "/Users/jane/work/repo",
      tipRef: "refs/heads/feature/x",
    }) as unknown as LocalFate;

  const BASE_KEYS = ["repoName", "commitSha", "branch", "fate"];
  const REPO_KEYS = ["repoKey", "mergedAs", "committedAt", "linesAdded", "linesDeleted", "filesChanged", "mine"];
  const PATCH_KEYS = ["patchId", "branchPatchId"];

  it.each([
    ["lists nothing (0.5.1-era)", [], BASE_KEYS],
    ["lists \"repo\" and \"match\" (today's 0.6 server)", ["repo", "match"], [...BASE_KEYS, ...REPO_KEYS]],
    ["lists only \"patch-id\"", ["patch-id"], [...BASE_KEYS, ...PATCH_KEYS]],
    ["lists every field", ["repo", "match", "usage-extras", "patch-id"], [...BASE_KEYS, ...REPO_KEYS, ...PATCH_KEYS]],
  ])("a server that %s gets exactly the allowed keys, nothing local", (_, fields, allowed) => {
    const wire = toWireFate(stuffedFate(), { fields: new Set(fields) });
    expect(Object.keys(wire).sort()).toEqual([...allowed].sort());
    const json = JSON.stringify(wire);
    for (const secret of SECRETS) expect(json).not.toContain(secret);
    expect(wire).toMatchObject({ repoName: "repo", commitSha: SHA, branch: "feature/x", fate: "shipped" });
    if (fields.includes("patch-id")) expect(wire).toMatchObject({ patchId: PATCH, branchPatchId: BRANCH_PATCH });
  });

  it("a fate without patch ids (a merge or root commit, a commit on the default branch) carries no patch keys, even to a \"patch-id\" server", () => {
    const f = { ...stuffedFate(), patchId: undefined, branchPatchId: undefined };
    const keys = Object.keys(toWireFate(f, { fields: new Set(["repo", "patch-id"]) }));
    expect(keys).not.toContain("patchId");
    expect(keys).not.toContain("branchPatchId");
  });
});
