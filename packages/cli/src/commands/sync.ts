import {
  type ParsedUsageEvent,
  readClaudeCodeAccount,
  scanClaudeCodeLogs,
} from "@centrail/parsers";
import { readAuth, readState, writeState } from "../config.js";

// 250 (not the server's 500 cap) — headroom so a batch of metadata-heavy
// events stays far below the 2MB body limit.
const BATCH_SIZE = 250;

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

  const scanned = await scanClaudeCodeLogs({ since });

  // Drop events the server would reject (clock-skewed or corrupt log lines)
  // — one bad timestamp must not 400 the batch and brick sync forever.
  const minOccurredAt = new Date("2020-01-01T00:00:00.000Z");
  const maxOccurredAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const events = scanned.filter(
    (e) =>
      e.externalId.length > 0 &&
      e.occurredAt >= minOccurredAt &&
      e.occurredAt <= maxOccurredAt,
  );
  const dropped = scanned.length - events.length;
  if (dropped > 0) {
    console.warn(
      `  ⚠ Skipped ${dropped} event${dropped === 1 ? "" : "s"} with out-of-range timestamps (corrupt or clock-skewed log lines).`,
    );
  }

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
