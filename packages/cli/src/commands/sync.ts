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
  writeConfig,
  writeLastSync,
  writeState,
  type Config,
} from "../config.js";
import { sinceForSurface, type SyncState } from "../watermarks.js";
import { versionHeaders } from "../version.js";
import { assertSecureBaseUrl } from "../url.js";
import { readRepoCommits, readRepoSize } from "../git.js";
import { Placer } from "../placer.js";
import { IdentityResolver } from "../resolver.js";
import { compactSidecar } from "../sidecar.js";
import { formatShipStatusLine, runFatePass } from "../ship-status.js";
import { eventInScope, surfaceEnabled } from "../scope.js";
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
  // Fresh installs answer the scope question in `connect`. An install that
  // synced before 0.6 consented under the old model; record that once.
  if (!config.scopeDecidedAt) {
    config.scopeDecidedAt = new Date().toISOString();
    await writeConfig(config);
  }
  const installId = await ensureInstallId();
  const caps = await readCapabilities(auth);
  await compactSidecar(); // under the sync lock; hook appends are line-atomic
  const resolver = await IdentityResolver.create(installId);
  const placer = new Placer(resolver);
  const minOccurredAt = new Date("2020-01-01T00:00:00.000Z");
  const maxOccurredAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  let grandInserted = 0;
  let grandSkipped = 0;
  let grandInbox = 0;
  let anyEvents = false;
  let anyWatermark = false;
  let heldByScope = 0;
  // Claude and Codex expose reliable per-event cwd/timestamps. Copilot
  // attribution remains deferred until its session semantics are proven.
  const attributionEvents: ParsedUsageEvent[] = [];

  // A widened scope (include, allow-list edit) rescans everything once: the
  // events it held back were already behind the watermark.
  const full = opts.full || config.pendingBackfill;

  for (const scanner of SCANNERS) {
    if (!surfaceEnabled(config, scanner.surface)) continue; // switched off; no watermark moves
    // Each surface keeps its own watermark so a scanner added in an upgrade
    // backfills its full history instead of inheriting another's cutoff.
    const mark = full ? undefined : sinceForSurface(state, scanner.surface, scanner.revision);
    if (mark) anyWatermark = true;
    const since = mark ? new Date(mark.getTime() - WATERMARK_OVERLAP_MS) : undefined;
    const scanStartedAt = new Date();
    const scanned = await scanner.scan({ since });
    const candidates = scanned.filter(
      (e) =>
        e.externalId.length > 0 &&
        e.occurredAt >= minOccurredAt &&
        e.occurredAt <= maxOccurredAt,
    );
    // Repo identity is placed here (§ 3.9: cwd → files → sticky → folder),
    // while the folder may still exist; the sidecar covers the sessions
    // whose folder is already gone. Then the scope decides what leaves: an
    // excluded repo's events stop here.
    await placer.place(scanned);
    const events = candidates.filter((e) => eventInScope(e, config));
    heldByScope += candidates.length - events.length;
    if (events.length === 0) {
      await stampSurface(state, scanner.surface, scanner.revision, scanStartedAt);
      continue;
    }
    anyEvents = true;
    if (scanner.surface === "claude-code" || scanner.surface === "codex") {
      for (const e of events) attributionEvents.push(e);
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

  if (config.pendingBackfill) {
    config.pendingBackfill = false; // every enabled surface got its full pass above
    await writeConfig(config);
  }

  if (!anyEvents) {
    if (heldByScope > 0) {
      console.log(`Nothing in scope to sync — ${heldByScope} event(s) held back by your scope (see \`centrail repos\`).`);
    } else {
      console.log(
        anyWatermark
          ? "No new events since the last sync."
          : "No agent usage found (Claude Code, Copilot CLI, Codex).",
      );
    }
    return;
  }

  if (attributionEvents.length > 0) {
    await pushAttributions(auth, attributionEvents, resolver, config, caps);
  }

  console.log(
    `Inserted ${grandInserted} · Skipped ${grandSkipped}` +
      (grandInbox > 0 ? ` · ${grandInbox} to review in Inbox` : "") +
      (heldByScope > 0 ? ` · ${heldByScope} held back by scope` : ""),
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
  const identityAware = caps.fields.has("repo");

  // One bucket per (checkout root, ref). A live checkout reads its own HEAD
  // log, as before. A session whose folder is gone joins a live checkout of
  // the same identity and reads the branch its sidecar line recorded —
  // branches outlive worktrees — or every ref when it was detached.
  type Bucket = { root: string; ref: string; name: string; key: string; events: ParsedUsageEvent[] };
  const buckets = new Map<string, Bucket>();
  const bucket = (root: string, ref: string, name: string, key: string): Bucket => {
    const id = `${root}\u0000${ref}`;
    let b = buckets.get(id);
    if (!b) buckets.set(id, (b = { root, ref, name, key, events: [] }));
    return b;
  };
  const orphans: ParsedUsageEvent[] = []; // repo known, folder gone
  for (const e of events) {
    const repo = e.metadata.repo;
    if (!repo || repo.source === "folder") continue; // scope already applied in syncLocked
    const root = await resolver.liveRootFor(e);
    if (!root) {
      orphans.push(e);
      continue;
    }
    bucket(root, "HEAD", repo.label, repo.key).events.push(e);
  }
  const rootByKey = new Map<string, string>();
  for (const b of buckets.values()) if (!rootByKey.has(b.key)) rootByKey.set(b.key, b.root);
  for (const e of orphans) {
    const repo = e.metadata.repo!;
    const root = rootByKey.get(repo.key);
    if (!root) continue; // no live checkout on this machine: usage ships, commits wait
    const branch = resolver.sidecarBranchFor(e);
    bucket(root, branch ? `refs/heads/${branch}` : "--all", repo.label, repo.key).events.push(e);
  }
  if (buckets.size === 0) return;

  const repos: { name: string; key?: string; totalLoc: number | null; fileCount: number }[] = [];
  const attributions: WireAttribution[] = [];
  const sizedRoots = new Set<string>();

  for (const { root, ref, name, key, events: repoEvents } of buckets.values()) {
    const commits = await readRepoCommits(root, ref);
    if (!sizedRoots.has(root)) {
      sizedRoots.add(root);
      const size = await readRepoSize(root);
      repos.push({
        name,
        ...(identityAware ? { key } : {}),
        totalLoc: size.totalLoc,
        fileCount: size.fileCount,
      });
    }

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
  const fateRepos = new Map<string, { root: string; name: string; key?: string }>();
  for (const b of buckets.values()) {
    if (!fateRepos.has(b.root)) fateRepos.set(b.root, { root: b.root, name: b.name, key: identityAware ? b.key : undefined });
  }
  const tally = await runFatePass(auth, [...fateRepos.values()]);
  if (tally) {
    console.log(`  ↳ ${formatShipStatusLine(tally)}`);
  }
}
