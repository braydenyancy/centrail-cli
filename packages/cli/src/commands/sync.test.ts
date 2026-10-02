import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // Anything not mocked below that touches the config dir (the sidecar)
  // lands in a scratch dir, never in the real ~/.config/centrail.
  process.env.CENTRAIL_CONFIG_DIR = `${process.env.TMPDIR ?? "/tmp"}/centrail-sync-test-${process.pid}-${Date.now()}`;
  return {
    scan: vi.fn(),
    writeState: vi.fn(),
    release: vi.fn(),
  };
});

vi.mock("@centrail/parsers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@centrail/parsers")>()),
  SCANNERS: [
    {
      surface: "claude-code",
      revision: 2,
      scan: mocks.scan,
    },
  ],
  matchEventsToCommits: vi.fn(() => []),
}));

vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  acquireSyncLock: vi.fn(async () => mocks.release),
  readAuth: vi.fn(async () => ({
    baseUrl: "https://centrail.org",
    token: "secret-token",
    deviceName: "Centrail CLI",
  })),
  readConfig: vi.fn(async () => ({
    installId: "3f0c2a8e-7d1b-4c55-9a3e-2b8f6d4e1c90",
    mode: "all",
    allowRepos: [],
    denyRepos: [],
    surfaces: {},
    scopeDecidedAt: "2026-09-27T00:00:00.000Z",
    pendingBackfill: false,
    hideRepoNames: false,
    hideBranchNames: false,
  })),
  ensureInstallId: vi.fn(async () => "3f0c2a8e-7d1b-4c55-9a3e-2b8f6d4e1c90"),
  readState: vi.fn(async () => ({
    lastSyncAt: null,
    surfaces: { "claude-code": "2026-09-27T00:00:00.000Z" },
    scannerRevisions: { "claude-code": 2 },
  })),
  writeState: mocks.writeState,
  writeConfig: vi.fn(async () => {}),
  writeLastSync: vi.fn(async () => {}),
}));

vi.mock("../ship-status.js", () => ({
  formatShipStatusLine: vi.fn(() => ""),
  runFatePass: vi.fn(async () => null),
}));

import { runSync } from "./sync.js";

// One parsed event carrying everything a parser or the CLI knows locally.
// `cwd` is a real folder (not a repo), so the placer gives it a folder id.
const localEvent = (cwd: string) => ({
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
  speed: "fast",
  webSearchRequests: 2,
  metadata: {
    cwd,
    gitBranch: "person/private-work",
    sessionId: "private-session",
    version: "9.9.9",
    entrypoint: "private-client",
    origin: { host: "private-host", platform: "darwin" },
  },
});

const USAGE = {
  externalId: "req_001",
  model: "claude-fable-5-1",
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 30,
  cacheCreationTokens: 40,
  cacheCreation5mTokens: 15,
  cacheCreation1hTokens: 25,
  occurredAt: "2026-09-28T12:00:00.000Z",
};

describe("runSync wire privacy", () => {
  const fetchMock = vi.fn();
  let fields: string[] | null = null; // null: the server has no capabilities route

  let cwd = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    cwd = await mkdtemp(join(tmpdir(), "centrail-sync-private-"));
    mocks.scan.mockResolvedValue([localEvent(cwd)]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/cli/capabilities")) {
        return fields === null
          ? new Response("not found", { status: 404 })
          : new Response(JSON.stringify({ fields }), { status: 200 });
      }
      return new Response(JSON.stringify({ inserted: 1, skipped: 0, inboxCount: 1 }), {
        status: 200,
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fields = null;
  });

  const ingestBody = () => {
    const ingests = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/cli/ingest"));
    expect(ingests).toHaveLength(1);
    const [url, init] = ingests[0] as [string, RequestInit];
    expect(url).toBe("https://centrail.org/api/cli/ingest");
    return init.body as string;
  };

  it("never includes local metadata, provider account data, or provider hints", async () => {
    await runSync({ full: false });

    const body = ingestBody();
    expect(JSON.parse(body)).toEqual({
      source: { surface: "claude-code", kind: "local_logs" },
      events: [USAGE],
    });
    expect(body).not.toContain(cwd);
    expect(body).not.toContain("private-session");
    expect(body).not.toContain("private-host");
    expect(body).not.toContain("anthropic");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("to a server that lists the § 3.10 fields: exactly those join, and still no path, host, platform, client or provider", async () => {
    fields = ["repo", "match", "usage-extras"];
    await runSync({ full: false });

    const body = ingestBody();
    const parsed = JSON.parse(body);
    expect(Object.keys(parsed).sort()).toEqual(["events", "source"]);
    const [event] = parsed.events;
    expect(event).toMatchObject({ ...USAGE, speed: "fast", webSearchRequests: 2 });
    expect(Object.keys(event).sort()).toEqual([...Object.keys(USAGE), "metadata", "speed", "webSearchRequests"].sort());
    expect(Object.keys(event.metadata).sort()).toEqual(["gitBranch", "origin", "placement", "repo", "sessionId"]);
    expect(event.metadata.origin).toEqual({ machineId: "3f0c2a8e-7d1b-4c55-9a3e-2b8f6d4e1c90" });
    expect(Object.keys(event.metadata.repo).sort()).toEqual(["key", "label", "source"]);
    expect(event.metadata.repo).toMatchObject({ source: "folder", key: expect.stringMatching(/^dir:[0-9a-f]{16}$/) });
    expect(event.metadata.placement).toBe("folder");
    expect(event.metadata).toMatchObject({ sessionId: "private-session", gitBranch: "person/private-work" });
    for (const local of [cwd, "private-host", "darwin", "private-client", "9.9.9", "anthropic"]) {
      expect(body).not.toContain(local);
    }
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
