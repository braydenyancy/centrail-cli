import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What the server says back about this machine: events another account
// already holds (decision A). Real config files in a scratch dir, a stubbed
// fetch, one stubbed scanner.
const mocks = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/centrail-server-test-${process.pid}-${Date.now()}`;
  process.env.CENTRAIL_CONFIG_DIR = dir;
  return { dir, scan: vi.fn() };
});

vi.mock("@centrail/parsers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@centrail/parsers")>()),
  SCANNERS: [{ surface: "claude-code", revision: 2, scan: mocks.scan }],
  matchEventsToCommits: vi.fn(() => []),
}));
vi.mock("../ship-status.js", () => ({ formatShipStatusLine: vi.fn(() => ""), runFatePass: vi.fn(async () => null) }));

import { heldElsewhereLine, runSync } from "./sync.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const AUTH = { baseUrl: "https://centrail.org", token: "tok", deviceName: "Centrail CLI" };

let routes: Record<string, () => Response>;
const fetchMock = vi.fn(async (url: string) => {
  const route = Object.keys(routes).find((r) => url.endsWith(r));
  return route ? routes[route]() : json({ error: "not found" }, 404);
});

let stdout: string[];
let stderr: string[];
const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
const setStderrTTY = (value: boolean) => Object.defineProperty(process.stderr, "isTTY", { value, configurable: true, writable: true });

beforeEach(async () => {
  await rm(mocks.dir, { recursive: true, force: true });
  await mkdir(mocks.dir, { recursive: true });
  await writeFile(join(mocks.dir, "auth.json"), JSON.stringify(AUTH));
  await writeFile(join(mocks.dir, "config.json"), JSON.stringify({ scopeDecidedAt: "2026-09-27T00:00:00.000Z" }));
  const cwd = await mkdtemp(join(tmpdir(), "centrail-server-cwd-"));
  mocks.scan.mockReset().mockResolvedValue([{
    externalId: "req_001", provider: "anthropic", model: "claude-fable-5-1",
    inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
    occurredAt: new Date(), metadata: { cwd },
  }]);
  routes = {
    "/api/cli/capabilities": () => json({ fields: [] }),
    "/api/cli/ingest": () => json({ inserted: 1, skipped: 0, inboxCount: 0 }),
  };
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("CI", "");
  setStderrTTY(false); // a hook's sync, or an agent's pipe
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void stdout.push(a.map(String).join(" ")));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (stderrTTY) Object.defineProperty(process.stderr, "isTTY", stderrTTY);
  else delete (process.stderr as { isTTY?: boolean }).isTTY;
});

describe("events another account holds (one provider event, one account)", () => {
  it("are said once, on their own line, and not counted again as skipped", async () => {
    routes["/api/cli/ingest"] = () => json({ inserted: 1, skipped: 1205, updated: 0, inboxCount: 0, heldElsewhere: 1204 });

    await runSync({ full: false });

    expect(stdout).toEqual([
      "Inserted 1 · Skipped 1",
      "1,204 events were already synced from this machine to another account; they stay there.",
    ]);
    expect(heldElsewhereLine(1)).toBe("1 event was already synced from this machine to another account; it stays there.");
  });

  it.each([
    ["zero", { heldElsewhere: 0 }],
    ["absent (an older server)", {}],
  ])("no line when %s", async (_, extra) => {
    routes["/api/cli/ingest"] = () => json({ inserted: 1, skipped: 2, inboxCount: 0, ...extra });

    await runSync({ full: false });

    expect(stdout).toEqual(["Inserted 1 · Skipped 2"]);
  });
});
