// The invariant every other test assumes: whatever the trigger order — hook,
// manual sync, --full, a failed batch, exclude then include, a worktree that
// dies — the server ends with exactly the transcript's final truth, once.
// Real bundle code (runSync, runStopHook), real git, real files, and an
// in-process stand-in server that models the real one: one row per
// (externalId), per-field max on re-send, `inserted` from what landed.
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scratch, type Scratch } from "../testing/git-fixture.js";

// Every module that reads CENTRAIL_CONFIG_DIR / CLAUDE_CONFIG_DIR at load or
// at call time must be imported AFTER the env is set, hence dynamic imports.
const home = await mkdtemp(join(tmpdir(), "centrail-harness-"));
process.env.CENTRAIL_CONFIG_DIR = join(home, "cfg");
process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
process.env.CODEX_HOME = join(home, "codex");
const { runSync } = await import("./sync.js");
const { runStopHook } = await import("./hook.js");
const { runExclude, runInclude } = await import("./scope.js");
const { writeAuth, writeConfig, parseConfig, readState } = await import("../config.js");

type Row = { externalId: string; outputTokens: number; metadata: Record<string, unknown> };

class StandIn {
  rows = new Map<string, Row>();
  attributions: Array<{ externalId: string; repoKey?: string; commitSha: string }> = [];
  ingestCalls = 0;
  failNextIngests = 0;
  fields: string[] = ["repo"];
  server!: Server;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/cli/capabilities") {
          res.end(JSON.stringify({ wireVersions: ["1"], surfaces: ["claude-code", "codex", "copilot-cli"], fields: this.fields }));
          return;
        }
        const payload = JSON.parse(body) as Record<string, unknown>;
        if (req.url === "/api/cli/ingest") {
          this.ingestCalls++;
          if (this.failNextIngests > 0) {
            this.failNextIngests--;
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "injected" }));
            return;
          }
          let inserted = 0;
          let skipped = 0;
          for (const e of payload.events as Row[]) {
            const prev = this.rows.get(e.externalId);
            if (!prev) {
              this.rows.set(e.externalId, e);
              inserted++;
            } else {
              prev.outputTokens = Math.max(prev.outputTokens, e.outputTokens); // the server's growth upsert
              skipped++;
            }
          }
          res.end(JSON.stringify({ inserted, skipped, inboxCount: 0 }));
          return;
        }
        const attributions = (payload.attributions as StandIn["attributions"] | undefined) ?? [];
        this.attributions.push(...attributions);
        res.end(JSON.stringify({ linked: attributions.length }));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const addr = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${addr.port}`;
  }
}

// Near the wall clock: incremental syncs only look 24 h behind their watermark.
const T0 = Date.now() - 60 * 60 * 1000;
function line(sessionId: string, cwd: string, requestId: string, out: number, atMs = T0): string {
  return JSON.stringify({
    type: "assistant",
    requestId,
    timestamp: new Date(atMs).toISOString(),
    cwd,
    sessionId,
    gitBranch: "HEAD",
    message: { id: `m_${requestId}`, model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } },
  });
}
function transcriptPath(cwd: string, sessionId: string): string {
  return join(home, "claude", "projects", cwd.replace(/[/.]/g, "-"), `${sessionId}.jsonl`);
}
async function writeTranscript(cwd: string, sessionId: string, lines: string[]): Promise<void> {
  const p = transcriptPath(cwd, sessionId);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, `${lines.join("\n")}\n`);
}

let fx: Scratch;
const server = new StandIn();
let repo: string;

beforeAll(async () => {
  await server.start();
  fx = await scratch();
  repo = await fx.repo("repo", { remote: "https://github.com/acme/repo.git" });
  await writeAuth({ baseUrl: server.url, token: "t", deviceName: "harness" });
  // Copilot's scanner reads the real home dir; keep the harness hermetic.
  await writeConfig(parseConfig({ surfaces: { "copilot-cli": false }, scopeDecidedAt: "2026-06-01T00:00:00Z" }));
});
afterAll(async () => {
  server.server.close();
  await fx.cleanup();
  await rm(home, { recursive: true, force: true });
});

const out = (id: string) => server.rows.get(id)?.outputTokens;

describe("sync invariants across triggers", () => {
  it("hook mid-stream, then manual, then --full: one row per request at its final count", async () => {
    // Turn 1 ends: the transcript holds request A with output streamed so far.
    await writeTranscript(repo, "s1", [line("s1", repo, "req_A", 5)]);
    let hookSync: Promise<void> | null = null;
    await runStopHook(JSON.stringify({ session_id: "s1", cwd: repo }), "claude-code", {
      spawnSync: () => void (hookSync = runSync({ full: false })),
      connected: async () => true,
    });
    await hookSync!;
    expect(out("req_A")).toBe(5);
    expect(server.rows.get("req_A")?.metadata.repo).toMatchObject({ key: "github.com/acme/repo" });

    // Claude finishes A (final line, larger output) and starts B; the user runs sync by hand.
    await writeTranscript(repo, "s1", [line("s1", repo, "req_A", 5), line("s1", repo, "req_A", 140), line("s1", repo, "req_B", 7, T0 + 60_000)]);
    await runSync({ full: false });
    expect(out("req_A")).toBe(140); // corrected by the overlap re-send + growth upsert
    expect(out("req_B")).toBe(7);

    // A full rescan changes nothing.
    const before = new Map([...server.rows].map(([k, v]) => [k, v.outputTokens]));
    await runSync({ full: true });
    expect(new Map([...server.rows].map(([k, v]) => [k, v.outputTokens]))).toEqual(before);
    expect(server.rows.size).toBe(2);
  });

  it("a line backdated behind the watermark still arrives (24 h overlap)", async () => {
    const state = await readState();
    const mark = new Date(state.surfaces["claude-code"]).getTime();
    // Written after the last sync, stamped 2 h before it (clock skew / long turn).
    await writeTranscript(repo, "s2", [line("s2", repo, "req_C", 3, mark - 2 * 60 * 60 * 1000)]);
    await runSync({ full: false });
    expect(out("req_C")).toBe(3);
  });

  it("a failed batch leaves the watermark alone; the next sync resends and lands it", async () => {
    await writeTranscript(repo, "s3", [line("s3", repo, "req_D", 11, T0 + 120_000)]);
    const markBefore = (await readState()).surfaces["claude-code"];
    server.failNextIngests = 1;
    await expect(runSync({ full: false })).rejects.toThrow(/Sync failed/);
    expect(out("req_D")).toBeUndefined();
    expect((await readState()).surfaces["claude-code"]).toBe(markBefore);
    await runSync({ full: false });
    expect(out("req_D")).toBe(11);
  });

  it("exclude holds a repo's events; include brings its history in without --full", async () => {
    const other = await fx.repo("other", { remote: "https://github.com/acme/other.git" });
    await runExclude("github.com/acme/other");
    await writeTranscript(other, "s4", [line("s4", other, "req_E", 9, T0 + 180_000)]);
    await runSync({ full: false });
    expect(out("req_E")).toBeUndefined();
    // The watermark moved past req_E while it was held back…
    await runInclude("github.com/acme/other");
    await runSync({ full: false });
    // …and include's one-time backfill brings it in anyway.
    expect(out("req_E")).toBe(9);
    expect(server.rows.get("req_E")?.metadata.repo).toMatchObject({ key: "github.com/acme/other" });
  });

  it("a worktree deleted after its hook line still ships identity and attributes via the sibling", async () => {
    const wt = await fx.worktree(repo, "repo-wt", "wt");
    const sha = await fx.commit(wt, "b.txt", undefined, new Date()); // after the event below
    await runStopHook(JSON.stringify({ session_id: "s5", cwd: wt }), "claude-code", {
      spawnSync: () => {},
      connected: async () => false,
    });
    await fx.git(repo, "worktree", "remove", "--force", wt);
    // The event precedes the commit it produced.
    await writeTranscript(wt, "s5", [line("s5", wt, "req_F", 4, T0)]);
    await runSync({ full: false });
    expect(server.rows.get("req_F")?.metadata.repo).toMatchObject({ key: "github.com/acme/repo", label: "repo-wt" });
    expect(server.rows.get("req_F")?.metadata.cwd).toBeUndefined();
    expect(server.attributions.find((a) => a.externalId === "req_F")).toMatchObject({ repoKey: "github.com/acme/repo", commitSha: sha });
  });

  it("against a 0.5-era server the body is the 0.5 shape", async () => {
    server.fields = [];
    await writeTranscript(repo, "s6", [line("s6", repo, "req_G", 2, T0 + 240_000)]);
    await runSync({ full: false });
    const row = server.rows.get("req_G")!;
    expect(row.metadata.cwd).toBe(repo);
    expect(row.metadata.repo).toBeUndefined();
    expect((row.metadata.origin as { host: string }).host).toBeTruthy();
    server.fields = ["repo"];
  });

  it("nothing on the wire ever carried the home path or hostname while identity-aware", () => {
    const { hostname } = require("node:os") as typeof import("node:os");
    for (const row of server.rows.values()) {
      if (row.externalId === "req_G") continue;
      const text = JSON.stringify(row);
      expect(text).not.toContain(hostname());
      expect(text).not.toContain(home);
    }
  });
});
