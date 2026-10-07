import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dir = vi.hoisted(() => {
  // CONFIG_DIR is read at import: point it at a scratch dir first, so no
  // test ever reads or writes the real ~/.config/centrail.
  const d = `${process.env.TMPDIR ?? "/tmp"}/centrail-connect-test-${process.pid}-${Date.now()}`;
  process.env.CENTRAIL_CONFIG_DIR = d;
  return d;
});

vi.mock("./scope.js", () => ({ runSetup: vi.fn(async () => {}) }));

import { PRIVATE_DEVICE_NAME, runConnect } from "./connect.js";

const INSTALL_ID = "3f0c2a8e-7d1b-4c55-9a3e-2b8f6d4e1c90";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const readJson = async (name: string) => JSON.parse(await readFile(join(dir, name), "utf-8"));
const writeJson = (name: string, value: unknown) => writeFile(join(dir, name), JSON.stringify(value));

// Pairs at once: one pair response, then an approved poll.
function serverApproving(account?: { email: string }) {
  return vi.fn(async (url: string) =>
    url.endsWith("/api/cli/pair")
      ? json({ code: "ABCD-EFGH", pollToken: "poll", verificationUrl: "https://centrail.org/connect?code=ABCD-EFGH", interval: 0, expiresIn: 60 })
      : json({ status: "approved", token: "tok-new", ...(account ? { account } : {}) }),
  );
}
const pairBody = (fetchMock: ReturnType<typeof vi.fn>) => JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);

beforeEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runConnect privacy boundary", () => {
  it("uses a generic label and sends no machine fingerprint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: "stop after request" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runConnect({ baseUrl: "https://centrail.org" })).rejects.toThrow("Pairing request failed");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://centrail.org/api/cli/pair");
    expect(JSON.parse(init.body as string)).toEqual({ hostname: PRIVATE_DEVICE_NAME });
    expect(init.body).not.toContain(process.env.HOSTNAME ?? "__missing_hostname__");
    expect(init.body).not.toContain(process.platform);
  });

  it("sends the install id only once the scope question is answered (§ 3.7)", async () => {
    await writeJson("config.json", { installId: INSTALL_ID });
    let fetchMock = serverApproving();
    vi.stubGlobal("fetch", fetchMock);
    await runConnect({ baseUrl: "https://centrail.org", noBrowser: true });
    expect(pairBody(fetchMock)).toEqual({ hostname: PRIVATE_DEVICE_NAME });

    await writeJson("config.json", { installId: INSTALL_ID, scopeDecidedAt: "2026-09-27T00:00:00.000Z" });
    fetchMock = serverApproving();
    vi.stubGlobal("fetch", fetchMock);
    await runConnect({ baseUrl: "https://centrail.org", noBrowser: true });
    expect(pairBody(fetchMock)).toEqual({ hostname: PRIVATE_DEVICE_NAME, installId: INSTALL_ID });
  });
});

describe("runConnect pairing", () => {
  const synced = { lastSyncAt: null, surfaces: { "claude-code": "2026-10-06T00:00:00.000Z" }, scannerRevisions: { "claude-code": 2 } };

  it("stores who approved, and re-reads the history for a new account, which keeps what the old one holds", async () => {
    await writeJson("auth.json", { baseUrl: "https://centrail.org", token: "tok-a", deviceName: PRIVATE_DEVICE_NAME, account: { email: "a@example.test" } });
    await writeJson("state.json", synced);
    vi.stubGlobal("fetch", serverApproving({ email: "b@example.test" }));

    await runConnect({ baseUrl: "https://centrail.org", noBrowser: true });

    expect(await readJson("auth.json")).toMatchObject({ token: "tok-new", account: { email: "b@example.test" } });
    expect((await readJson("state.json")).surfaces).toEqual({});
    expect((await readJson("state.json")).scannerRevisions).toEqual({ "claude-code": 2 });
    const said = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toContain("This machine is paired with a@example.test");
    expect(said).toContain("Paired with b@example.test");
    expect(said).toContain("What this machine synced to a@example.test stays there; b@example.test gets everything else.");
  });

  it("keeps the watermarks when the same account re-pairs", async () => {
    await writeJson("auth.json", { baseUrl: "https://centrail.org", token: "tok-a", deviceName: PRIVATE_DEVICE_NAME, account: { email: "a@example.test" } });
    await writeJson("state.json", synced);
    vi.stubGlobal("fetch", serverApproving({ email: "a@example.test" }));

    await runConnect({ baseUrl: "https://centrail.org", noBrowser: true });

    expect((await readJson("state.json")).surfaces).toEqual(synced.surfaces);
  });

  it("forgets the watermarks when the server does not say who approved", async () => {
    await writeJson("state.json", synced);
    vi.stubGlobal("fetch", serverApproving());

    await runConnect({ baseUrl: "https://centrail.org", noBrowser: true });

    expect((await readJson("state.json")).surfaces).toEqual({});
  });

  it("clears a parked disconnect once paired again", async () => {
    await writeJson("auth.disconnected.json", { baseUrl: "https://centrail.org", token: "tok-old", deviceName: PRIVATE_DEVICE_NAME, reason: "device_revoked", disconnectedAt: "2026-10-07T00:00:00.000Z" });
    vi.stubGlobal("fetch", serverApproving({ email: "a@example.test" }));

    await runConnect({ baseUrl: "https://centrail.org", noBrowser: true });

    await expect(readFile(join(dir, "auth.disconnected.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
