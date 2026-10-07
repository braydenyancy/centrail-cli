// The 0.6 upgrade migration, CLI half: every scanner's revision is bumped,
// so the first sync after upgrading re-sends each surface's whole history
// once — and to a server that lists "repo" the re-sent events carry the
// identity metadata 0.5.1 never sent, so the server can enrich rows it
// already holds. The scope question is answered here; an install that has
// not answered it is sync.consent.test.ts. Real runSync, real git, real
// files, the stand-in server.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCANNERS } from "@centrail/parsers";
import { scratch, type Scratch } from "../testing/git-fixture.js";
import { StandIn, transcriptLine, writeTranscript as writeTranscriptIn, type Row } from "../testing/stand-in-server.js";

const home = await mkdtemp(join(tmpdir(), "centrail-migration-"));
process.env.CENTRAIL_CONFIG_DIR = join(home, "cfg");
process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
process.env.CODEX_HOME = join(home, "codex");
const { runSync } = await import("./sync.js");
const { writeAuth, writeConfig, parseConfig, readConfig, readState, writeState } = await import("../config.js");

const DAY = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// What 0.5.1 stamped (packages/parsers SCANNERS on main at 96be109).
const REVISIONS_0_5_1: Record<string, number> = { "claude-code": 2, "copilot-cli": 1, codex: 1 };

let fx: Scratch;
const server = new StandIn();

beforeAll(async () => {
  await server.start();
  fx = await scratch();
  await writeAuth({ baseUrl: server.url, token: "t", deviceName: "migration" });
  // Copilot's scanner reads the real home dir; keep the test hermetic.
  await writeConfig(parseConfig({ surfaces: { "copilot-cli": false }, scopeDecidedAt: "2026-06-01T00:00:00Z" }));
});
afterAll(async () => {
  server.close();
  await fx.cleanup();
  await rm(home, { recursive: true, force: true });
});

type SentEvent = { externalId: string; outputTokens: number; metadata?: Record<string, unknown> };
const sentSince = (n: number): SentEvent[] =>
  server.ingestBodies.slice(n).flatMap((b) => b.events as SentEvent[]);

describe("0.6 upgrade: one full re-send carries identity to rows the server already holds", () => {
  it("bumps every surface past what 0.5.1 stamped", () => {
    for (const s of SCANNERS) expect(s.revision, s.surface).toBeGreaterThan(REVISIONS_0_5_1[s.surface] ?? 0);
  });

  it.each([
    ["a server that lists \"repo\"", ["repo", "match", "usage-extras"], true],
    ["a server that lists nothing", [], false],
  ])("against %s: history older than the overlap is re-sent once, then never again", async (_, fields, identity) => {
    const n = fields.length;
    const repo = await fx.repo(`mig-${n}`, { remote: `https://github.com/acme/mig-${n}.git` });
    const now = Date.now();
    const old = `req_old_${n}`; // ten days back: far behind any watermark's 24 h overlap
    const recent = `req_new_${n}`;
    await writeTranscriptIn(join(home, "claude"), repo, `sess-${n}`, [
      transcriptLine({ sessionId: `sess-${n}`, cwd: repo, requestId: old, out: 30, atMs: now - 10 * DAY, gitBranch: "feature/mig" }),
      transcriptLine({ sessionId: `sess-${n}`, cwd: repo, requestId: recent, out: 7, atMs: now - 60_000, gitBranch: "feature/mig" }),
    ]);

    // A 0.5.1 install: it synced everything as bare usage numbers and left
    // its own watermarks and scanner revisions in state.json, nothing else.
    server.fields = [];
    await runSync({ full: true });
    expect(server.rows.get(old)?.metadata).toBeUndefined();
    const state = await readState();
    const stamped051 = SCANNERS.filter((s) => state.surfaces[s.surface]).map((s) => [s.surface, state.surfaces[s.surface]]);
    await writeState({ lastSyncAt: null, surfaces: Object.fromEntries(stamped051), scannerRevisions: { ...REVISIONS_0_5_1 } });
    const rowsBefore = server.rows.size;

    // Upgrade to 0.6.0. The server lists what it lists; the first sync re-sends everything.
    server.fields = fields;
    let mark = server.ingestBodies.length;
    await runSync({ full: false });
    const resent = sentSince(mark).find((e) => e.externalId === old);
    expect(resent, "the ten-day-old event is re-sent").toBeDefined();
    expect(resent!.outputTokens).toBe(30);
    if (identity) {
      const { installId } = await readConfig();
      expect(installId).toMatch(UUID); // random, minted once; never derived from the machine
      const rootSha = (await fx.git(repo, "rev-list", "--max-parents=0", "HEAD")).trim();
      expect(resent!.metadata).toEqual({
        repo: { key: `github.com/acme/mig-${n}`, label: `mig-${n}`, source: "remote", root: rootSha },
        placement: "cwd",
        sessionId: `sess-${n}`,
        gitBranch: "feature/mig",
        origin: { machineId: installId },
      });
    } else {
      expect(resent!.metadata).toBeUndefined(); // still the 0.5.1 shape
    }
    // A re-send, never a new row, and every surface now stamped at its revision.
    expect(server.rows.size).toBe(rowsBefore);
    expect(server.out(old)).toBe(30);
    const stamped = (await readState()).scannerRevisions;
    for (const s of SCANNERS) {
      if (s.surface === "copilot-cli") continue; // switched off in this config: never scanned, never stamped
      expect(stamped[s.surface], s.surface).toBe(s.revision);
    }

    // Once. The next sync reads only its 24 h overlap.
    mark = server.ingestBodies.length;
    await runSync({ full: false });
    const again = sentSince(mark).map((e) => e.externalId);
    expect(again).not.toContain(old);
    expect(again).toContain(recent);
  });

  it("upgraded before the server listed \"repo\": the history goes once more when it starts to, with identity, and a failed pass retries", async () => {
    const repo = await fx.repo("mig-late", { remote: "https://github.com/acme/mig-late.git" });
    const old = "req_old_late";
    await writeTranscriptIn(join(home, "claude"), repo, "sess-late", [
      transcriptLine({ sessionId: "sess-late", cwd: repo, requestId: old, out: 12, atMs: Date.now() - 9 * DAY }),
    ]);
    server.fields = [];
    await runSync({ full: true }); // the upgrade's re-send, to a server that lists nothing yet
    await runSync({ full: false });
    expect((await readState()).capabilities).toEqual([]);

    // The server deploys "repo". The first pass fails mid-way; nothing is lost.
    server.fields = ["repo", "match"];
    server.failNextIngests = 1;
    await expect(runSync({ full: false })).rejects.toThrow();
    let mark = server.ingestBodies.length;
    await runSync({ full: false });
    const resent = sentSince(mark).find((e) => e.externalId === old);
    expect(resent?.metadata).toMatchObject({ repo: { key: "github.com/acme/mig-late" }, sessionId: "sess-late" });

    mark = server.ingestBodies.length;
    await runSync({ full: false });
    expect(sentSince(mark).map((e) => e.externalId)).not.toContain(old);
  });
});

// Two CLIs on one machine: a global 0.5.1 install's `centrail sync` beside
// `npx centrail` — and, after the next revision bump, a plugin hook whose
// bundle is a release behind the npx one. Each stamps its own scanner
// revision over the other's. The newer one used to read the older stamp as
// "never completed at my revision" and re-send the whole history, every
// time (115k events on the reference machine). It must re-send only what it
// has not covered itself: what the older one sent since, in its older shape.
describe("an older CLI syncing between two newer syncs", () => {
  it("costs the newer one a re-send since its own last pass, never the whole history", async () => {
    server.fields = ["repo", "match"];
    const repo = await fx.repo("alt", { remote: "https://github.com/acme/alt.git" });
    const claude = join(home, "claude");
    const now = Date.now();
    await writeTranscriptIn(claude, repo, "sess-alt", [
      transcriptLine({ sessionId: "sess-alt", cwd: repo, requestId: "req_alt_old", out: 3, atMs: now - 10 * DAY }),
    ]);
    await runSync({ full: true }); // 0.6's own pass: everything, with identity

    // Five days on, 0.5.1 synced a session 0.6 has not seen, as bare numbers,
    // and rewrote state.json as 0.5.1 does: its own watermark and revisions,
    // and only the fields it knows.
    const state = await readState();
    for (const [k, v] of Object.entries(state.surfaces)) state.surfaces[k] = new Date(Date.parse(v) - 5 * DAY).toISOString();
    await writeTranscriptIn(claude, repo, "sess-alt-2", [
      transcriptLine({ sessionId: "sess-alt-2", cwd: repo, requestId: "req_alt_mid", out: 6, atMs: now - 3 * DAY }),
    ]);
    server.rows.set("req_alt_mid", { externalId: "req_alt_mid", outputTokens: 6 } as Row);
    state.surfaces["claude-code"] = new Date(now - 60_000).toISOString();
    await writeState({ lastSyncAt: state.lastSyncAt, surfaces: state.surfaces, scannerRevisions: { ...REVISIONS_0_5_1 } });

    const mark = server.ingestBodies.length;
    await runSync({ full: false });
    const sent = sentSince(mark).map((e) => e.externalId);
    expect(sent).not.toContain("req_alt_old"); // behind 0.6's own pass: never again
    expect(sent).toContain("req_alt_mid"); // behind 0.5.1's watermark, but 0.5.1 sent it without identity…
    expect(server.rows.get("req_alt_mid")?.metadata).toMatchObject({ repo: { key: "github.com/acme/alt" } }); // …which this fills
    expect((await readState()).scannerRevisions["claude-code"]).toBe(SCANNERS[0].revision);
  });
});
