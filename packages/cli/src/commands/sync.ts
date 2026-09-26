import {
  matchEventsToCommits,
  SCANNERS,
  type AttributionEvent,
  type EventAttribution,
  type ParsedUsageEvent,
} from "@centrail/parsers";
import {
  acquireSyncLock,
  ensureInstallId,
  readAuth,
  readConfig,
  readState,
  writeLastSync,
  writeState,
  type Config,
} from "../config.js";
import { sinceForSurface, type SyncState } from "../watermarks.js";
import { versionHeaders } from "../version.js";
import { assertSecureBaseUrl } from "../url.js";
import { readRepoCommits, readRepoSize } from "../git.js";
import { IdentityResolver } from "../resolver.js";
import { formatShipStatusLine, runFatePass } from "../ship-status.js";
import { readCapabilities, toWireEvent, type Capabilities } from "../wire.js";

// 250 (not the server's 500 cap) — headroom so a batch of metadata-heavy
// events stays far below the 2MB body limit.
const BATCH_SIZE = 250;

// Every incremental sync re-reads this much of the trailing window. A
// transcript line can carry a timestamp earlier than the moment it reaches
// disk — a long streaming turn, a log synced from another machine, clock
// skew — so a watermark taken at scan start can sit past events that were
// not written yet. The server dedupes on externalId, so the overlap costs a
// re-send that is counted as "skipped", never a duplicate and never a loss.
const WATERMARK_OVERLAP_MS = 24 * 60 * 60 * 1000;

type IngestResponse = {
  inserted: number;
  skipped: number;
  inboxCount: number;
};

export async function runSync(opts: { full: boolean }): Promise<void> {
  const release = await acquireSyncLock();
  if (!release) {
    console.log("Another sync is already running on this machine — skipped.");
    return;
  }
  try {
    await syncLocked(opts);
  } finally {
    await release();
  }
}

async function syncLocked(opts: { full: boolean }): Promise<void> {
  const auth = await readAuth();
  if (!auth) {
    throw new Error("Not connected — run `centrail connect` first");
  }
  assertSecureBaseUrl(auth.baseUrl);

  const state = await readState();
  const config = await readConfig();
  const installId = await ensureInstallId();
  const caps = await readCapabilities(auth);
  const resolver = await IdentityResolver.create(installId);
  const minOccurredAt = new Date("2020-01-01T00:00:00.000Z");
  const maxOccurredAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  let grandInserted = 0;
  let grandSkipped = 0;
  let grandInbox = 0;
  let anyEvents = false;
  let anyWatermark = false;
  // Claude and Codex expose reliable per-event cwd/timestamps. Copilot
  // attribution remains deferred until its session semantics are proven.
  const attributionEvents: ParsedUsageEvent[] = [];

  for (const scanner of SCANNERS) {
    // Each surface keeps its own watermark so a scanner added in an upgrade
    // backfills its full history instead of inheriting another's cutoff.
    const mark = opts.full
      ? undefined
      : sinceForSurface(state, scanner.surface, scanner.revision);
    if (mark) anyWatermark = true;
    const since = mark ? new Date(mark.getTime() - WATERMARK_OVERLAP_MS) : undefined;
    const scanStartedAt = new Date();
    const scanned = await scanner.scan({ since });
    const events = scanned.filter(
      (e) =>
        e.externalId.length > 0 &&
        e.occurredAt >= minOccurredAt &&
        e.occurredAt <= maxOccurredAt,
    );
    if (events.length === 0) {
      await stampSurface(state, scanner.surface, scanner.revision, scanStartedAt);
      continue;
    }
    anyEvents = true;
    // Repo identity is stamped here, while the folder may still exist; the
    // sidecar covers the sessions whose folder is already gone.
    for (const e of events) await resolver.stamp(e);
    if (scanner.surface === "claude-code" || scanner.surface === "codex") {
      attributionEvents.push(...events);
    }

    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);
      const body = {
        source: { surface: scanner.surface, kind: "local_logs" },
        events: batch.map((e) => toWireEvent(e, caps, config, installId)),
      };
      await writeLastSync(body); // `centrail inspect --last`: exactly what left
      const res = await fetch(`${auth.baseUrl}/api/cli/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${auth.token}`,
          ...versionHeaders(),
        },
        body: JSON.stringify(body),
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

    // Only after every batch for this surface landed; a failure above throws
    // and leaves this surface's watermark where it was.
    await stampSurface(state, scanner.surface, scanner.revision, scanStartedAt);
  }

  if (!anyEvents) {
    console.log(
      anyWatermark
        ? "No new events since the last sync."
        : "No agent usage found (Claude Code, Copilot CLI, Codex).",
    );
    return;
  }

  if (attributionEvents.length > 0) {
    await pushAttributions(auth, attributionEvents, resolver, config, caps);
  }

  console.log(
    `Inserted ${grandInserted} · Skipped ${grandSkipped}` +
      (grandInbox > 0 ? ` · ${grandInbox} to review in Inbox` : ""),
  );
}

async function stampSurface(
  state: SyncState,
  surface: string,
  revision: number,
  scanStartedAt: Date,
): Promise<void> {
  state.surfaces[surface] = scanStartedAt.toISOString();
  state.scannerRevisions[surface] = revision;
  await writeState(state);
}

type WireAttribution = {
  externalId: string;
  repoName: string;
  repoKey?: string; // identity key; the server binds rules to this once it can
  commitSha: string;
  committedAt: string;
  branch: string | null;
  linesAdded: number;
  linesDeleted: number;
  filesChanged: number;
};

// Group events by repo, match each repo's events to its commits, and POST the
// mapping. Git history never leaves the machine; only the derived rows do.
// Failures here are logged, not thrown — attribution is best-effort and must
// never brick a successful event sync.
//
// A session whose folder is gone (a deleted worktree — 70% of tokens on the
// reference machine) still attributes when ANY live checkout of the same
// repo identity exists on this machine: commits are shared across
// worktrees and clones, so its history answers for the dead folder.
async function pushAttributions(
  auth: { baseUrl: string; token: string },
  events: ParsedUsageEvent[],
  resolver: IdentityResolver,
  config: Config,
  caps: Capabilities,
): Promise<void> {
  const deny = new Set(config.denyRepos);
  const identityAware = caps.fields.has("repo");

  // repoRoot -> { name, key, events }: one bucket per live checkout root.
  const byRepo = new Map<
    string,
    { name: string; key: string; events: ParsedUsageEvent[] }
  >();
  const orphans: ParsedUsageEvent[] = []; // repo known, folder gone
  for (const e of events) {
    const repo = e.metadata.repo;
    if (!repo || repo.source === "folder") continue;
    if (deny.has(repo.key) || deny.has(repo.label)) continue;
    const root = await resolver.liveRootFor(e);
    if (!root) {
      orphans.push(e);
      continue;
    }
    const bucket = byRepo.get(root) ?? { name: repo.label, key: repo.key, events: [] };
    bucket.events.push(e);
    byRepo.set(root, bucket);
  }
  // Orphans join the first live bucket carrying their identity.
  const rootByKey = new Map<string, string>();
  for (const [root, b] of byRepo) if (!rootByKey.has(b.key)) rootByKey.set(b.key, root);
  for (const e of orphans) {
    const root = rootByKey.get(e.metadata.repo!.key);
    if (root) byRepo.get(root)!.events.push(e);
  }
  if (byRepo.size === 0) return;

  const repos: { name: string; key?: string; totalLoc: number | null; fileCount: number }[] = [];
  const attributions: WireAttribution[] = [];

  for (const [root, { name, key, events: repoEvents }] of byRepo) {
    const commits = await readRepoCommits(root);
    const size = await readRepoSize(root);
    repos.push({
      name,
      ...(identityAware ? { key } : {}),
      totalLoc: size.totalLoc,
      fileCount: size.fileCount,
    });

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
        ...(identityAware ? { repoKey: key } : {}),
        commitSha: m.sha,
        committedAt: m.committedAt.toISOString(),
        branch: branchByExternalId.get(m.externalId) ?? null,
        linesAdded: m.linesAdded,
        linesDeleted: m.linesDeleted,
        filesChanged: m.filesChanged,
      });
    }
  }

  if (attributions.length > 0) {
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

  // Fate pass: recompute shipped / in_flight / unshipped for every recent sha
  // in each resolved repo. Repos without a resolvable default branch are
  // skipped inside runFatePass (never guess); when none pass, no line prints.
  const tally = await runFatePass(
    auth,
    [...byRepo].map(([root, { name, key }]) => ({ root, name, key: identityAware ? key : undefined })),
  );
  if (tally) {
    console.log(`  ↳ ${formatShipStatusLine(tally)}`);
  }
}
