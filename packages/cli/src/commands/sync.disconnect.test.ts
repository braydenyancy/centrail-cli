import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A machine whose pairing is gone (replaced from another machine, revoked in
// Settings, the account deleted): the sync says so in one line and parks the
// token, so the Stop hook stops starting syncs that can only fail.
const mocks = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/centrail-disconnect-test-${process.pid}-${Date.now()}`;
  process.env.CENTRAIL_CONFIG_DIR = dir;
  return { dir, scan: vi.fn() };
});

vi.mock("@centrail/parsers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@centrail/parsers")>()),
  SCANNERS: [{ surface: "claude-code", revision: 2, scan: mocks.scan }],
  matchEventsToCommits: vi.fn(() => []),
}));
vi.mock("../ship-status.js", () => ({ formatShipStatusLine: vi.fn(() => ""), runFatePass: vi.fn(async () => null) }));

import { readAuth } from "../config.js";
import { runSync } from "./sync.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const AUTH = { baseUrl: "https://centrail.org", token: "tok", deviceName: "Centrail CLI" };

let routes: Record<string, () => Response>;
const fetchMock = vi.fn(async (url: string) => {
  const route = Object.keys(routes).find((r) => url.endsWith(r));
  return route ? routes[route]() : json({ error: "not found" }, 404);
});

beforeEach(async () => {
  await rm(mocks.dir, { recursive: true, force: true });
  await mkdir(mocks.dir, { recursive: true });
  await writeFile(join(mocks.dir, "auth.json"), JSON.stringify(AUTH));
  await writeFile(join(mocks.dir, "config.json"), JSON.stringify({ scopeDecidedAt: "2026-09-27T00:00:00.000Z" }));
  const cwd = await mkdtemp(join(tmpdir(), "centrail-disconnect-cwd-"));
  mocks.scan.mockReset().mockResolvedValue([{
    externalId: "req_001", provider: "anthropic", model: "claude-fable-5-1",
    inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
    occurredAt: new Date(), metadata: { cwd },
  }]);
  routes = { "/api/cli/capabilities": () => json({ fields: [] }) };
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const parked = async () => JSON.parse(await readFile(join(mocks.dir, "auth.disconnected.json"), "utf-8"));

describe("sync on a machine whose pairing is gone", () => {
  it("asks first, and a revoked device never scans", async () => {
    routes["/api/cli/device"] = () => json({ error: "Invalid or revoked token", code: "device_revoked" }, 401);

    await expect(runSync({ full: false })).rejects.toThrow(/replaced from another machine or revoked in Settings → Devices.*npx centrail connect/);

    expect(mocks.scan).not.toHaveBeenCalled();
    expect(await readAuth()).toBeNull();
    expect(await parked()).toMatchObject({ token: "tok", reason: "device_revoked" });
  });

  it("parks on ingest's 401 when the server predates the device check", async () => {
    routes["/api/cli/ingest"] = () => json({ error: "Invalid or revoked token", code: "unknown_token" }, 401);

    await expect(runSync({ full: false })).rejects.toThrow(/account may have been deleted/);

    expect(await readAuth()).toBeNull();
    expect(await parked()).toMatchObject({ reason: "unknown_token" });
  });

  it("an older server's bare 401 still parks, with the general reason", async () => {
    routes["/api/cli/ingest"] = () => json({ error: "Invalid or revoked token" }, 401);

    await expect(runSync({ full: false })).rejects.toThrow(/refused its token/);
    expect(await parked()).toMatchObject({ reason: "unauthorized" });
  });

  it("says why on every later run, instead of \"Not connected\"", async () => {
    routes["/api/cli/device"] = () => json({ code: "device_revoked" }, 401);
    await expect(runSync({ full: false })).rejects.toThrow();
    fetchMock.mockClear();

    await expect(runSync({ full: false })).rejects.toThrow(/no longer connected to Centrail/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("syncs as before when the device check confirms the pairing", async () => {
    routes["/api/cli/device"] = () => json({ account: { email: "a@example.test" }, device: { name: "Centrail CLI", pairedAt: "2026-10-01T00:00:00.000Z" } });
    routes["/api/cli/ingest"] = () => json({ inserted: 1, skipped: 0, inboxCount: 0 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runSync({ full: false });

    expect(log).toHaveBeenCalledWith("Inserted 1 · Skipped 0");
    expect(await readAuth()).toMatchObject({ token: "tok" });
    log.mockRestore();
  });
});
