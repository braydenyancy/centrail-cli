import {
  type ParsedUsageEvent,
  readClaudeCodeAccount,
  scanClaudeCodeLogs,
} from "@centrail/parsers";
import { readAuth, readState, writeState } from "../config.js";

const BATCH_SIZE = 500;

type IngestResponse = {
  inserted: number;
  skipped: number;
  inboxCount: number;
};

export async function runSync(opts: { full: boolean }): Promise<void> {
  const auth = await readAuth();
  if (!auth) {
    throw new Error("Not connected — run `centrail connect` first");
  }

  const state = await readState();
  const since =
    !opts.full && state.lastSyncAt ? new Date(state.lastSyncAt) : undefined;
  const startedAt = new Date();

  const events = await scanClaudeCodeLogs({ since });
  if (events.length === 0) {
    console.log(
      since
        ? `No new events since ${since.toLocaleString()}.`
        : "No Claude Code usage found at ~/.claude/projects.",
    );
    return;
  }

  const account = await readClaudeCodeAccount();

  let inserted = 0;
  let skipped = 0;
  let inboxCount = 0;
  const batches = Math.ceil(events.length / BATCH_SIZE);

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batchNo = i / BATCH_SIZE + 1;
    const batch = events.slice(i, i + BATCH_SIZE);

    const res = await fetch(`${auth.baseUrl}/api/cli/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({
        source: { provider: "anthropic", kind: "local_logs" },
        account,
        events: batch.map(serializeEvent),
      }),
    });

    if (res.status === 401) {
      throw new Error("Token revoked or expired — run `centrail connect`");
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      // Watermark NOT advanced: the failed batch (and any after it) re-push
      // on the next sync; server-side dedup makes the overlap free.
      throw new Error(
        `Batch ${batchNo}/${batches} failed (${res.status})${
          body?.error ? `: ${body.error}` : ""
        }`,
      );
    }

    const result = (await res.json()) as IngestResponse;
    inserted += result.inserted;
    skipped += result.skipped;
    inboxCount += result.inboxCount;
  }

  await writeState({ lastSyncAt: startedAt.toISOString() });

  console.log(
    `Scanned ${events.length} · Inserted ${inserted} · Skipped ${skipped}` +
      (inboxCount > 0 ? ` · ${inboxCount} to review in Inbox` : ""),
  );
}

function serializeEvent(e: ParsedUsageEvent): Record<string, unknown> {
  return { ...e, occurredAt: e.occurredAt.toISOString() };
}
