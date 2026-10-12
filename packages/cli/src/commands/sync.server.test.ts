import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What the server says back about this machine and this CLI: events another
// account already holds (decision A), a newer release, a version it no
// longer accepts (decision B). Real config files in a scratch dir, a stubbed
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

import { readAuth, readState } from "../config.js";
import { CLI_VERSION } from "../version.js";
import { runStopHook } from "./hook.js";
import { runStatus } from "./status.js";
import { heldElsewhereLine, runSync } from "./sync.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const AUTH = { baseUrl: "https://centrail.org", token: "tok", deviceName: "Centrail CLI" };
const AHEAD = "99.0.0";

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
    "/api/cli/capabilities": () => json({ fields: [], cli: { minimum: "0.1.0" } }),
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

describe("compatibility with a server that still enforces cross-account ownership", () => {
  it("are said once, on their own line, and not counted again as skipped", async () => {
    routes["/api/cli/ingest"] = () => json({ inserted: 1, skipped: 1205, updated: 0, inboxCount: 0, heldElsewhere: 1204 });

    await runSync({ full: false });

    expect(stdout).toEqual([
      "Inserted 1 · Skipped 1",
      "1,204 events were already synced from this machine to another account; they stay there.",
    ]);
    expect(heldElsewhereLine(1)).toBe("1 event was already synced from this machine to another account; it stays there.");
  });

  it("are not repeated by the incremental syncs that re-read the day before the move", async () => {
    await runSync({ full: false }); // the full pass after a move sets the watermark
    routes["/api/cli/ingest"] = () => json({ inserted: 1, skipped: 1205, updated: 0, inboxCount: 0, heldElsewhere: 1204 });
    stdout = [];

    await runSync({ full: false });

    expect(stdout).toEqual(["Inserted 1 · Skipped 1"]);
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

describe("a newer release", () => {
  beforeEach(() => {
    routes["/api/cli/capabilities"] = () => json({ fields: [], cli: { latest: AHEAD, minimum: "0.1.0" } });
  });
  const said = () => stderr.filter((w) => w.includes(`centrail ${AHEAD} is available (you have ${CLI_VERSION})`));

  it("is one stderr line in a terminal, after the summary", async () => {
    setStderrTTY(true);

    await runSync({ full: false });

    expect(said()).toHaveLength(1);
    expect(stdout).toEqual(["Inserted 1 · Skipped 0"]); // stdout is the summary, as before
  });

  it("without a terminal says nothing, and is kept for `centrail status`", async () => {
    await runSync({ full: false });

    expect(stderr).toEqual([]);
    expect((await readState()).updateNotice).toMatchObject({ version: CLI_VERSION, latest: AHEAD });

    routes["/api/cli/device"] = () => json({ account: { email: "a@example.test" }, device: { pairedAt: "2026-10-01T00:00:00.000Z" } });
    stdout = [];
    await runStatus();
    expect(stdout[0]).toMatch(/^Connected to centrail\.org as a@example\.test/);
    expect(stdout[1]).toMatch(new RegExp(`^centrail ${AHEAD} is available \\(you have ${CLI_VERSION.replace(/\./g, "\\.")}\\): `));
  });

  it("is forgotten once this version is the latest, and an older server changes nothing", async () => {
    await runSync({ full: false });
    expect((await readState()).updateNotice).toBeDefined();

    routes["/api/cli/capabilities"] = () => json({ fields: [] });
    await runSync({ full: false });
    expect((await readState()).updateNotice).toBeDefined();

    routes["/api/cli/capabilities"] = () => json({ fields: [], cli: { latest: CLI_VERSION, minimum: "0.1.0" } });
    await runSync({ full: false });
    expect((await readState()).updateNotice).toBeUndefined();
  });
});

describe("a version the server no longer accepts", () => {
  const refused = () => json({ error: "This CLI is too old", code: "cli_outdated", minimum: AHEAD }, 426);

  it("a 426 on ingest parks the version, keeps the pairing, and names the minimum and the update", async () => {
    routes["/api/cli/ingest"] = refused;

    await expect(runSync({ full: false })).rejects.toThrow(
      new RegExp(`centrail ${CLI_VERSION.replace(/\./g, "\\.")} is older than the server accepts \\(${AHEAD.replace(/\./g, "\\.")} or newer\\), so syncing has stopped until it is updated: `),
    );

    expect(await readAuth()).toMatchObject({ token: "tok" }); // not a revoked token
    expect((await readState()).outdated).toMatchObject({ version: CLI_VERSION, minimum: AHEAD });
  });

  it("then this version's Stop hook starts no syncs, and `status` says why", async () => {
    routes["/api/cli/ingest"] = refused;
    await expect(runSync({ full: false })).rejects.toThrow();

    const scratch = await mkdtemp(join(tmpdir(), "centrail-server-hook-"));
    let spawns = 0;
    await runStopHook(JSON.stringify({ session_id: "s", cwd: scratch }), "claude-code", {
      sidecarPath: join(scratch, "sessions.jsonl"),
      spawnSync: () => void spawns++,
      connected: async () => true,
    });
    expect(spawns).toBe(0);

    stdout = [];
    await runStatus();
    expect(stdout.some((l) => l.includes(`older than the server accepts (${AHEAD} or newer)`))).toBe(true);
  });

  it("a minimum above this version in capabilities parks it before any scan", async () => {
    routes["/api/cli/capabilities"] = () => json({ fields: [], cli: { latest: AHEAD, minimum: AHEAD } });

    await expect(runSync({ full: false })).rejects.toThrow(/older than the server accepts/);

    expect(mocks.scan).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/cli/ingest"))).toBe(false);
    expect((await readState()).outdated).toMatchObject({ version: CLI_VERSION, minimum: AHEAD });
  });

  it("a sync by hand tries again, and an accepted one lifts the park", async () => {
    routes["/api/cli/ingest"] = refused;
    await expect(runSync({ full: false })).rejects.toThrow();

    routes["/api/cli/ingest"] = () => json({ inserted: 1, skipped: 0, inboxCount: 0 });
    await runSync({ full: false });

    expect((await readState()).outdated).toBeUndefined();
  });
});
