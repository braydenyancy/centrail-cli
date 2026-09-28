import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  writeState: vi.fn(),
  resolveRepoRoot: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@centrail/parsers", () => ({
  SCANNERS: [
    {
      surface: "claude-code",
      revision: 2,
      scan: mocks.scan,
    },
  ],
  matchEventsToCommits: vi.fn(() => []),
}));

vi.mock("../config.js", () => ({
  acquireSyncLock: vi.fn(async () => mocks.release),
  readAuth: vi.fn(async () => ({
    baseUrl: "https://centrail.org",
    token: "secret-token",
    deviceName: "Centrail CLI",
  })),
  readConfig: vi.fn(async () => ({ denyRepos: [] })),
  readState: vi.fn(async () => ({
    lastSyncAt: null,
    surfaces: { "claude-code": "2026-09-27T00:00:00.000Z" },
    scannerRevisions: { "claude-code": 2 },
  })),
  writeState: mocks.writeState,
}));

vi.mock("../git.js", () => ({
  readRepoCommits: vi.fn(async () => []),
  readRepoSize: vi.fn(async () => ({ totalLoc: null, fileCount: 0 })),
  repoName: vi.fn(() => "private-repo"),
  resolveRepoRoot: mocks.resolveRepoRoot,
}));

vi.mock("../ship-status.js", () => ({
  formatShipStatusLine: vi.fn(() => ""),
  runFatePass: vi.fn(async () => null),
}));

import { runSync } from "./sync.js";

describe("runSync wire privacy", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    mocks.resolveRepoRoot.mockResolvedValue(null);
    mocks.scan.mockResolvedValue([
      {
        externalId: "req_001",
        provider: "anthropic",
        model: "claude-fable-5-1",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 40,
        cacheCreation5mTokens: 15,
        cacheCreation1hTokens: 25,
        occurredAt: new Date("2026-09-28T12:00:00.000Z"),
        metadata: {
          cwd: "/Users/private/company/repo",
          gitBranch: "person/private-work",
          sessionId: "private-session",
          origin: { host: "private-host", platform: "darwin" },
        },
      },
    ]);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ inserted: 1, skipped: 0, inboxCount: 1 }), {
        status: 200,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never includes local metadata, provider account data, or provider hints", async () => {
    await runSync({ full: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://centrail.org/api/cli/ingest");
    expect(JSON.parse(init.body as string)).toEqual({
      source: { surface: "claude-code", kind: "local_logs" },
      events: [
        {
          externalId: "req_001",
          model: "claude-fable-5-1",
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheCreationTokens: 40,
          cacheCreation5mTokens: 15,
          cacheCreation1hTokens: 25,
          occurredAt: "2026-09-28T12:00:00.000Z",
        },
      ],
    });
    expect(init.body).not.toContain("/Users/private");
    expect(init.body).not.toContain("private-session");
    expect(init.body).not.toContain("private-host");
    expect(init.body).not.toContain("anthropic");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
