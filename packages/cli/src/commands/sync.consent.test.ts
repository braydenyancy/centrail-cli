// Upgrading from 0.5.x asks before any repo name leaves (decision § 3.7:
// "Nothing syncs before that answer"). An install that synced under 0.5.1
// has never seen the scope question; until it answers, every sync sends
// exactly what 0.5.1 sent, whatever the server lists. The answer — from a
// sync in a terminal, `setup`, `connect` or `install-hooks` — re-sends the
// history once with identity, which the server fills into the rows it holds.
// Real runSync / runStopHook / runSetup / runConnect, real git, real files,
// the stand-in server, and a scripted terminal.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { scratch, type Scratch } from "../testing/git-fixture.js";
import { StandIn, transcriptLine, writeTranscript, type Row } from "../testing/stand-in-server.js";
import { inTerminal } from "../testing/terminal.js";

// Pairing protocol is real here, but launching the user's desktop browser
// is an external side effect, not part of the stand-in server fixture.
const browser = vi.hoisted(() => ({ openBrowser: vi.fn(() => true), shouldOpenBrowser: vi.fn(() => true) }));
vi.mock("../browser.js", () => browser);

const home = await mkdtemp(join(tmpdir(), "centrail-consent-"));
const claudeDir = join(home, "claude");
process.env.HOME = join(home, "home"); // discovery scans every surface; Copilot's reads $HOME
process.env.CENTRAIL_CONFIG_DIR = join(home, "cfg");
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.CODEX_HOME = join(home, "codex");
const { runSync } = await import("./sync.js");
const { runStopHook } = await import("./hook.js");
const scope = await import("./scope.js");
const { runConnect } = await import("./connect.js");
const { CONFIG_DIR, readConfig, readLastSync, writeAuth, writeState } = await import("../config.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
// What 0.5.1 stamped (packages/parsers SCANNERS on main at 96be109).
const REVISIONS_0_5_1: Record<string, number> = { "claude-code": 2, "copilot-cli": 1, codex: 1 };
// The 0.5.1 bodies, key for key (96be109: wire.ts, sync.ts, ship-status.ts).
const EVENT_0_5_1 = ["cacheCreation1hTokens", "cacheCreation5mTokens", "cacheCreationTokens", "cacheReadTokens", "externalId", "inputTokens", "model", "occurredAt", "outputTokens"];
const REPO_0_5_1 = ["fileCount", "name", "totalLoc"];
const ATTRIBUTION_0_5_1 = ["branch", "commitSha", "committedAt", "externalId", "filesChanged", "linesAdded", "linesDeleted", "repoName"];
const FATE_0_5_1 = ["branch", "commitSha", "fate", "repoName"];
const PROMPT = "Sync all of these";
const UNANSWERED = "Scope not answered";

let fx: Scratch;
const server = new StandIn();
let open: string;

type SentEvent = Record<string, unknown> & { externalId: string; metadata?: { repo?: { key: string } } };
const sentSince = (n: number): SentEvent[] => server.ingestBodies.slice(n).flatMap((b) => b.events as SentEvent[]);
const keys = (o: object) => Object.keys(o).sort();
const line = (sessionId: string, cwd: string, requestId: string, out: number, atMs: number, gitBranch?: string) =>
  transcriptLine({ sessionId, cwd, requestId, out, atMs, gitBranch });

// A 0.5.1 install as it sits on disk the moment 0.6 replaces it: the config
// 0.5.1 wrote (an exclusion by folder name, nothing else), its state (its
// own scanner revisions and a watermark, no capability list), its token.
async function install051(): Promise<void> {
  await rm(CONFIG_DIR, { recursive: true, force: true });
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeAuth({ baseUrl: server.url, token: "t", deviceName: "Centrail CLI" });
  await writeFile(join(CONFIG_DIR, "config.json"), `${JSON.stringify({ denyRepos: ["private"] })}\n`);
  await writeState({
    lastSyncAt: null,
    surfaces: { "claude-code": new Date(NOW - 2 * 60 * 60 * 1000).toISOString() },
    scannerRevisions: { ...REVISIONS_0_5_1 },
  });
}

// What 0.5.1 sent for a request: usage numbers, no metadata. Its exclude
// held back commit attribution only, so the excluded repo's usage went too.
function sentBy051(externalId: string, outputTokens: number, atMs: number): Row {
  return {
    externalId,
    model: "claude-opus-4-8",
    inputTokens: 10,
    outputTokens,
    cacheReadTokens: 1000,
    cacheCreationTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    occurredAt: new Date(atMs).toISOString(),
  } as unknown as Row;
}

beforeAll(async () => {
  await server.start();
  server.fields = ["repo", "match", "usage-extras", "patch-id"];
  fx = await scratch();
  await mkdir(process.env.HOME!, { recursive: true });
  open = await fx.repo("open", { remote: "https://github.com/acme/open.git" });
  const priv = await fx.repo("private", { remote: "https://github.com/acme/private.git" });
  await fx.git(open, "checkout", "-q", "-b", "feature/open");
  const old = NOW - 10 * DAY; // behind any watermark's 24 h overlap
  const recent = NOW - 60 * 60 * 1000;
  await writeTranscript(claudeDir, open, "s-open", [
    line("s-open", open, "req_old", 30, old, "feature/open"),
    line("s-open", open, "req_new", 7, recent, "feature/open"),
  ]);
  await writeTranscript(claudeDir, priv, "s-priv", [line("s-priv", priv, "req_priv", 5, recent)]);
  await fx.commit(open, "o.txt", undefined, new Date(NOW - 30 * 60 * 1000)); // after req_new: it attributes here
  await install051();
  for (const row of [sentBy051("req_old", 30, old), sentBy051("req_new", 7, recent), sentBy051("req_priv", 5, recent)]) {
    server.rows.set(row.externalId, row);
  }
});
afterAll(async () => {
  server.close();
  await fx.cleanup();
  await rm(home, { recursive: true, force: true });
});

describe("upgrading from 0.5.x: nothing beyond the 0.5.1 wire leaves before the scope question is answered", () => {
  it("a hook-started sync on an install that never answered sends the 0.5.1 wire on every route, keeps the exclusion, asks nothing and records no answer", async () => {
    const ingestFrom = server.ingestBodies.length;
    const attributeFrom = server.attributeBodies.length;
    let started: Promise<void> | null = null;
    const { output } = await inTerminal({ tty: false }, async () => {
      await runStopHook(JSON.stringify({ session_id: "s-open", cwd: open }), "claude-code", {
        spawnSync: () => void (started = runSync({ full: false })),
        connected: async () => true,
      });
      expect(started).not.toBeNull();
      await started;
    });

    // The upgrade's re-send (every scanner revision is bumped) goes, as numbers.
    const events = sentSince(ingestFrom);
    expect(events.map((e) => e.externalId).sort()).toEqual(["req_new", "req_old"]); // the excluded repo stays home
    for (const e of events) expect(keys(e)).toEqual(EVENT_0_5_1);
    const ingest = JSON.stringify(server.ingestBodies.slice(ingestFrom));
    for (const s of ["acme", "open", "feature/open", "s-open"]) expect(ingest).not.toContain(s);
    expect(server.rows.get("req_old")?.metadata).toBeUndefined();

    // The attribute route as 0.5.1 shaped it: the CLI matched commits itself
    // ("match" is not used), no repo keys, no commit facts, no patch ids, no
    // facts block.
    const bodies = server.attributeBodies.slice(attributeFrom);
    const attributions = bodies.flatMap((b) => b.attributions ?? []);
    const fates = bodies.flatMap((b) => b.fates ?? []);
    expect(attributions.map((a) => a.externalId)).toContain("req_new");
    expect(fates.length).toBeGreaterThan(0);
    for (const r of bodies.flatMap((b) => b.repos ?? [])) expect(keys(r)).toEqual(REPO_0_5_1);
    for (const a of attributions) expect(keys(a)).toEqual(ATTRIBUTION_0_5_1);
    for (const f of fates) expect(keys(f)).toEqual(FATE_0_5_1);
    for (const b of bodies) expect(b.facts).toBeUndefined();
    expect(JSON.stringify(bodies)).not.toContain("acme");
    expect(JSON.stringify(bodies)).not.toContain("private");

    // No answer recorded, no question asked, one short line says why.
    const cfg = await readConfig();
    expect(cfg.scopeDecidedAt).toBeNull();
    expect(cfg.pendingBackfill).toBe(false);
    expect(output).not.toContain(PROMPT);
    expect(output.split("\n").filter((l) => l.includes(UNANSWERED))).toHaveLength(1);
  });

  it("until it is answered, `repos` and `inspect --last` say so, and `inspect --last` is the numbers-only body", async () => {
    const repos = await inTerminal({ tty: false }, () => scope.runRepos());
    expect(repos.output).toContain(UNANSWERED);
    const inspect = await inTerminal({ tty: false }, () => scope.runInspect());
    expect(inspect.output).toContain(UNANSWERED);
    const last = JSON.parse((await readLastSync())!) as { events: SentEvent[] };
    expect(last.events.length).toBeGreaterThan(0);
    for (const e of last.events) expect(keys(e)).toEqual(EVENT_0_5_1);
  });

  it("answered through `setup`, the next sync re-sends the history once with identity, the server fills its rows without adding one, and a failed pass retries", async () => {
    const { output } = await inTerminal({ tty: true, input: ["y"] }, () => scope.runSetup({ interactive: true }));
    expect(output).toContain(PROMPT);
    const cfg = await readConfig();
    expect(cfg.scopeDecidedAt).not.toBeNull();
    expect(cfg.pendingBackfill).toBe(true);
    expect(cfg.denyRepos).toEqual(["private"]);

    // The first pass fails mid-way: the re-send is still owed.
    server.failNextIngests = 1;
    await expect(inTerminal({ tty: false }, () => runSync({ full: false }))).rejects.toThrow(/Sync failed/);
    expect((await readConfig()).pendingBackfill).toBe(true);

    const rowsBefore = server.rows.size;
    const from = server.ingestBodies.length;
    const sync = await inTerminal({ tty: false }, () => runSync({ full: false }));
    expect(sync.output).not.toContain(UNANSWERED);
    const resent = sentSince(from);
    // Ten days old, behind the overlap: only the answer's re-send brings it.
    expect(resent.find((e) => e.externalId === "req_old")?.metadata?.repo).toMatchObject({ key: "github.com/acme/open" });
    expect(resent.map((e) => e.externalId)).not.toContain("req_priv");
    expect(server.rows.get("req_old")?.metadata).toMatchObject({
      repo: { key: "github.com/acme/open" },
      sessionId: "s-open",
      gitBranch: "feature/open",
    });
    expect(server.rows.size).toBe(rowsBefore);
    expect(server.out("req_old")).toBe(30);
    expect((await readConfig()).pendingBackfill).toBe(false);

    // Replaying the recently modified file leaves one row per event.
    const again = server.ingestBodies.length;
    await inTerminal({ tty: false }, () => runSync({ full: false }));
    expect(sentSince(again).map((e) => e.externalId)).toContain("req_old");
  });

  it("a sync in a terminal with the question unanswered asks it once, as `connect` does, records the answer and goes on with identity", async () => {
    await install051();
    const from = server.ingestBodies.length;
    const first = await inTerminal({ tty: true, input: ["y"] }, () => runSync({ full: false }));
    expect(first.output.split(PROMPT)).toHaveLength(2); // asked exactly once
    const cfg = await readConfig();
    expect(cfg.scopeDecidedAt).not.toBeNull();
    expect(cfg.denyRepos).toEqual(["private"]);
    expect(cfg.pendingBackfill).toBe(false); // the same run made the full pass
    const sent = sentSince(from);
    expect(sent.find((e) => e.externalId === "req_old")?.metadata?.repo).toMatchObject({ key: "github.com/acme/open" });
    expect(sent.map((e) => e.externalId)).not.toContain("req_priv");

    // Answered is answered: the next sync in a terminal asks nothing.
    const second = await inTerminal({ tty: true, input: [] }, () => runSync({ full: false }));
    expect(second.output).not.toContain(PROMPT);
    expect(second.output).not.toContain(UNANSWERED);
  });

  it("a fresh install is unchanged: `connect` asks, the answer holds at the first sync, and that sync carries identity", async () => {
    // A machine that never ran centrail: no config, no state, no install id,
    // and its own logs — a repo session and a folder that is not a repo,
    // with more events so it lists first.
    await rm(CONFIG_DIR, { recursive: true, force: true });
    const freshClaude = join(home, "claude-fresh");
    const notes = join(fx.root, "notes");
    await mkdir(notes);
    const fresh = await fx.repo("fresh", { remote: "https://github.com/acme/fresh.git" });
    const at = NOW - 60 * 60 * 1000;
    await writeTranscript(freshClaude, notes, "s-notes", [line("s-notes", notes, "req_n1", 1, at), line("s-notes", notes, "req_n2", 1, at + 1000)]);
    await writeTranscript(freshClaude, fresh, "s-fresh", [line("s-fresh", fresh, "req_fresh", 4, at + 2000)]);
    process.env.CLAUDE_CONFIG_DIR = freshClaude;
    try {
      // "Sync all?" no; exclude row 1, the folder.
      // No `claude` here: the plugin offer must never run the real one.
      const { output } = await inTerminal({ tty: true, input: ["n", "1"] }, () => runConnect({ baseUrl: server.url }, { claude: null }));
      expect(browser.openBrowser).toHaveBeenCalledOnce();
      expect(browser.openBrowser).toHaveBeenCalledWith(`${server.url}/pair`, server.url);
      expect(output).toContain("Opened in your browser");
      expect(output.split(PROMPT)).toHaveLength(2);
      const cfg = await readConfig();
      expect(cfg.scopeDecidedAt).not.toBeNull();
      expect(cfg.denyRepos).toEqual([expect.stringMatching(/^dir:/)]);

      const from = server.ingestBodies.length;
      const sync = await inTerminal({ tty: false }, () => runSync({ full: false }));
      expect(sync.output).not.toContain(UNANSWERED);
      const sent = sentSince(from);
      expect(sent.find((e) => e.externalId === "req_fresh")?.metadata?.repo).toMatchObject({ key: "github.com/acme/fresh" });
      // The folder excluded at `connect` stays home: the key the list showed
      // is the key the sync computes, under the same install id.
      expect(sent.map((e) => e.externalId)).not.toContain("req_n1");
      expect((await readConfig()).installId).toBe(cfg.installId);
    } finally {
      process.env.CLAUDE_CONFIG_DIR = claudeDir;
    }
  });
});
