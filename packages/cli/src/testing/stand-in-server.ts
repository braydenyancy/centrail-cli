// An in-process stand-in for centrail.org, for harness tests that drive the
// real `runSync` / `runStopHook`. It models exactly the server behaviour the
// CLI relies on and nothing else: one row per externalId, per-field growth
// on re-send, `inserted` from what landed, capabilities `fields`, and it
// records every attribute body (repos, attributions, fates) it receives.
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Row = {
  externalId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  metadata: Record<string, unknown>;
};
export type AttributeBody = {
  repos: Array<{ name: string; key?: string }>;
  attributions: Array<{ externalId: string; repoName: string; repoKey?: string; commitSha: string; branch: string | null }>;
  fates?: Array<{ repoName: string; repoKey?: string; commitSha: string; fate: string }>;
};

const GROW = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const;

export class StandIn {
  rows = new Map<string, Row>();
  ingestBodies: Array<Record<string, unknown>> = [];
  attributeBodies: AttributeBody[] = [];
  ingestCalls = 0;
  failNextIngests = 0;
  fields: string[] = ["repo"];
  server!: Server;
  url = "";

  get attributions(): AttributeBody["attributions"] {
    return this.attributeBodies.flatMap((b) => b.attributions ?? []);
  }
  get repos(): AttributeBody["repos"] {
    return this.attributeBodies.flatMap((b) => b.repos ?? []);
  }
  get fates(): NonNullable<AttributeBody["fates"]> {
    return this.attributeBodies.flatMap((b) => b.fates ?? []);
  }
  out(externalId: string): number | undefined {
    return this.rows.get(externalId)?.outputTokens;
  }

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
          this.ingestBodies.push(payload);
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
              for (const f of GROW) prev[f] = Math.max(prev[f], e[f]); // the server's growth upsert
              skipped++;
            }
          }
          res.end(JSON.stringify({ inserted, skipped, inboxCount: 0 }));
          return;
        }
        const b = payload as unknown as AttributeBody;
        this.attributeBodies.push(b);
        res.end(JSON.stringify({ linked: (b.attributions ?? []).length }));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const addr = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${addr.port}`;
  }
  close(): void {
    this.server.close();
  }
}

// A Claude Code transcript line: one content block of one response.
export function transcriptLine(o: {
  sessionId: string;
  cwd: string;
  requestId: string;
  out: number;
  atMs: number;
  gitBranch?: string;
  toolUse?: { name: string; input: Record<string, unknown> };
}): string {
  const content: unknown[] = o.toolUse
    ? [{ type: "tool_use", id: `tu_${o.requestId}`, name: o.toolUse.name, input: o.toolUse.input }]
    : [{ type: "text", text: "ok" }];
  return JSON.stringify({
    type: "assistant",
    requestId: o.requestId,
    timestamp: new Date(o.atMs).toISOString(),
    cwd: o.cwd,
    sessionId: o.sessionId,
    gitBranch: o.gitBranch ?? "HEAD",
    message: {
      id: `m_${o.requestId}`,
      model: "claude-opus-4-8",
      content,
      usage: { input_tokens: 10, output_tokens: o.out, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
    },
  });
}

// Claude Code's project dir name for a cwd: every `/` and `.` becomes `-`.
export function transcriptPath(claudeDir: string, cwd: string, sessionId: string): string {
  return join(claudeDir, "projects", cwd.replace(/[/.]/g, "-"), `${sessionId}.jsonl`);
}

export async function writeTranscript(claudeDir: string, cwd: string, sessionId: string, lines: string[]): Promise<string> {
  const p = transcriptPath(claudeDir, cwd, sessionId);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, `${lines.join("\n")}\n`);
  return p;
}
