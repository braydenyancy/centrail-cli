import {
  matchEventsToCommits,
  SCANNERS,
  type AttributionEvent,
  type EventAttribution,
  type ParsedUsageEvent,
} from "@centrail/parsers";
import { readAuth, readConfig, readState, writeState } from "../config.js";
import { versionHeaders } from "../version.js";
import { assertSecureBaseUrl } from "../url.js";
import {
  readRepoCommits,
  readRepoSize,
  repoName,
  resolveRepoRoot,
} from "../git.js";

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
  assertSecureBaseUrl(auth.baseUrl);

  const state = await readState();
  const since =
    !opts.full && state.lastSyncAt ? new Date(state.lastSyncAt) : undefined;
  const startedAt = new Date();

  const minOccurredAt = new Date("2020-01-01T00:00:00.000Z");
  const maxOccurredAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  let grandInserted = 0;
  let grandSkipped = 0;
  let grandInbox = 0;
  let anyEvents = false;
  // Keep Claude events for attribution (Copilot attribution is deferred).
  let claudeEvents: ParsedUsageEvent[] = [];

  for (const scanner of SCANNERS) {
    const scanned = await scanner.scan({ since });
    const events = scanned.filter(
      (e) =>
        e.externalId.length > 0 &&
        e.occurredAt >= minOccurredAt &&
        e.occurredAt <= maxOccurredAt,
    );
    if (events.length === 0) continue;
    anyEvents = true;
    if (scanner.surface === "claude-code") claudeEvents = events;

    const account = scanner.readAccount ? await scanner.readAccount() : null;

    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);
      const res = await fetch(`${auth.baseUrl}/api/cli/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${auth.token}`,
          ...versionHeaders(),
        },
        body: JSON.stringify({
          source: { surface: scanner.surface, kind: "local_logs" },
          account,
          events: batch.map(serializeEvent),
        }),
      });
      if (res.status === 401) {
        throw new Error("Token revoked or expired — run `centrail connect`");
      }
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(
          `Sync failed for ${scanner.surface} (${res.status})${b?.error ? `: ${b.error}` : ""}`,
        );
      }
      const result = (await res.json()) as IngestResponse;
      grandInserted += result.inserted;
      grandSkipped += result.skipped;
      grandInbox += result.inboxCount;
    }
  }

  if (!anyEvents) {
    console.log(
      since
        ? `No new events since ${since.toLocaleString()}.`
        : "No agent usage found (Claude Code, Copilot CLI).",
    );
    return;
  }

  await writeState({ lastSyncAt: startedAt.toISOString() });

  if (claudeEvents.length > 0) {
    await pushAttributions(auth, claudeEvents);
  }

  console.log(
    `Inserted ${grandInserted} · Skipped ${grandSkipped}` +
      (grandInbox > 0 ? ` · ${grandInbox} to review in Inbox` : ""),
  );
}

function serializeEvent(e: ParsedUsageEvent): Record<string, unknown> {
  return { ...e, occurredAt: e.occurredAt.toISOString() };
}

type WireAttribution = {
  externalId: string;
  repoName: string;
  commitSha: string;
  committedAt: string;
  branch: string | null;
  linesAdded: number;
  linesDeleted: number;
  filesChanged: number;
};

// Group events by cwd -> repo, match each repo's events to its commits, and
// POST the mapping. Git history never leaves the machine; only the derived
// rows do. Failures here are logged, not thrown — attribution is best-effort
// and must never brick a successful event sync.
async function pushAttributions(
  auth: { baseUrl: string; token: string },
  events: ParsedUsageEvent[],
): Promise<void> {
  const config = await readConfig();
  const deny = new Set(config.denyRepos);

  // Bucket events by cwd; resolve each distinct cwd to a repo root once.
  const byCwd = new Map<string, ParsedUsageEvent[]>();
  for (const e of events) {
    const cwd = e.metadata.cwd;
    if (!cwd) continue;
    (byCwd.get(cwd) ?? byCwd.set(cwd, []).get(cwd)!).push(e);
  }

  // repoRoot -> { name, events }
  const byRepo = new Map<
    string,
    { name: string; events: ParsedUsageEvent[] }
  >();
  for (const [cwd, cwdEvents] of byCwd) {
    const root = await resolveRepoRoot(cwd);
    if (!root) continue;
    const name = repoName(root);
    if (deny.has(name)) continue;
    const bucket = byRepo.get(root) ?? { name, events: [] };
    bucket.events.push(...cwdEvents);
    byRepo.set(root, bucket);
  }
  if (byRepo.size === 0) return;

  const repos: { name: string; totalLoc: number | null; fileCount: number }[] = [];
  const attributions: WireAttribution[] = [];

  for (const [root, { name, events: repoEvents }] of byRepo) {
    const commits = await readRepoCommits(root);
    const size = await readRepoSize(root);
    repos.push({ name, totalLoc: size.totalLoc, fileCount: size.fileCount });

    const input: AttributionEvent[] = repoEvents.map((e) => ({
      externalId: e.externalId,
      occurredAt: e.occurredAt,
    }));
    const matched: EventAttribution[] = matchEventsToCommits(input, commits);
    // gitBranch is per-event; look it up from the first event with that id.
    const branchByExternalId = new Map(
      repoEvents.map((e) => [e.externalId, e.metadata.gitBranch || null]),
    );
    for (const m of matched) {
      attributions.push({
        externalId: m.externalId,
        repoName: name,
        commitSha: m.sha,
        committedAt: m.committedAt.toISOString(),
        branch: branchByExternalId.get(m.externalId) ?? null,
        linesAdded: m.linesAdded,
        linesDeleted: m.linesDeleted,
        filesChanged: m.filesChanged,
      });
    }
  }

  if (attributions.length === 0) return;

  // Chunk attributions to stay under the server's 2000-per-batch cap.
  // All repos are included in every chunk (small, referenced by attributions).
  const ATTR_CHUNK = 1000;
  let totalLinked = 0;
  try {
    for (let i = 0; i < attributions.length; i += ATTR_CHUNK) {
      const chunk = attributions.slice(i, i + ATTR_CHUNK);
      const res = await fetch(`${auth.baseUrl}/api/cli/attribute`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${auth.token}`,
          ...versionHeaders(),
        },
        body: JSON.stringify({ repos, attributions: chunk }),
      });
      if (res.ok) {
        const r = (await res.json()) as { linked: number };
        totalLinked += r.linked;
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        console.warn(`  ⚠ Attribution chunk skipped (${res.status})${body?.error ? `: ${body.error}` : ""}.`);
      }
    }
    if (totalLinked > 0) {
      console.log(`  ↳ Attributed ${totalLinked} event(s) to commits.`);
    }
  } catch (err) {
    console.warn("  ⚠ Attribution request failed:", (err as Error).message);
  }
}
