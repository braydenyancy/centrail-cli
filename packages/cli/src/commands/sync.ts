import {
  claudeConfigDirs,
  matchEventsToCommits,
  SCANNERS,
  type AttributionEvent,
  type EventAttribution,
  type ParsedUsageEvent,
} from "@centrail/parsers";
import {
  acquireSyncLock,
  disconnectedMessage,
  ensureInstallId,
  parkAuth,
  parkOutdated,
  readAuth,
  readConfig,
  readDisconnected,
  readState,
  writeConfig,
  writeLastSync,
  writeState,
  type AuthConfig,
  type Config,
  type DisconnectReason,
} from "../config.js";
import { checkDevice, refusalReason } from "../device.js";
import { progress, progressDone, progressStatus } from "../progress.js";
import { sinceForSurface, stampWatermark, type SyncState } from "../watermarks.js";
import { versionHeaders } from "../version.js";
import { assertSecureBaseUrl } from "../url.js";
import { readRepoCommits, readRepoSize } from "../git.js";
import { Placer } from "../placer.js";
import { IdentityResolver } from "../resolver.js";
import { compactSidecar, readSidecar } from "../sidecar.js";
import { formatShipStatusLine, runFatePass } from "../ship-status.js";
import { eventInScope, surfaceEnabled } from "../scope.js";
import { consentedCapabilities, readCapabilities, toWireEvent, wireBranch, wireRepoRef, type Capabilities } from "../wire.js";
import { CliOutdatedError, here, isOlder, minimumFrom, sameInstall, settleVersions, updateNoticeLine } from "../update.js";
import { isInteractiveTerminal, runSetup, SCOPE_UNANSWERED } from "./scope.js";

// 250 (not the server's 500 cap) — headroom so a batch of metadata-heavy
// events stays far below the 2MB body limit.
const BATCH_SIZE = 250;

// Capability fields that change what an event carries (wire.ts).
const RESEND_ON_GAIN = ["repo", "usage-extras"];

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
  // Compatibility with the earlier cross-account ownership server: it can
  // return events held by another account inside `skipped`, so the summary
  // reports them once, apart. Account-local servers return zero; older
  // servers can omit the field.
  heldElsewhere?: number;
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
    const parked = await readDisconnected();
    throw new Error(parked ? disconnectedMessage(parked) : "Not connected — run `centrail connect` first");
  }
  assertSecureBaseUrl(auth.baseUrl);
  const device = await checkDevice(auth);
  if (device.kind === "refused") await disconnect(device.reason);
  progress(`Syncing to ${new URL(auth.baseUrl).host}${accountLabel(auth, device.kind === "active" ? device.account : undefined)}`);

  // Fresh installs answer the scope question in `connect`. An install that
  // synced under 0.5.x never saw it (§ 3.7: nothing beyond the 0.5.1 wire
  // leaves before that answer). In a terminal it is asked here, once, and
  // the sync goes on; a sync a hook started has no terminal, never asks and
  // never waits, and sends what 0.5.1 sent.
  let config = await readConfig();
  if (!config.scopeDecidedAt) {
    if (isInteractiveTerminal()) {
      console.log("  Choose what syncs before any repo name leaves this machine (asked once).");
      await runSetup({ interactive: true });
      config = await readConfig();
    } else {
      console.log(SCOPE_UNANSWERED);
    }
  }
  const state = await readState();
  const installId = await ensureInstallId();
  const known = state.capabilities;
  const served = await readCapabilities(auth, known ? { fields: new Set(known) } : undefined);
  // Every route below reads `caps`, never `served`: empty while the scope is
  // unanswered, so events, attributions and fate rows all keep 0.5.1's shape.
  const caps = consentedCapabilities(served, config);
  const capsNow = [...served.fields].sort();
  // The server's word on this CLI's version: a notice while a newer release
  // is out (printed below, in a terminal; kept in state for `centrail
  // status`), and below the minimum a park instead of a scan whose every
  // write would be refused.
  const at = here();
  const versionsChanged = settleVersions(state, served.cli, at);
  // A server that starts listing a field events carry gets the history
  // re-sent once with it — the widened-scope rule: what it can now store
  // was held back from events already behind the watermark. Marked before
  // the new list is saved, and cleared only after a complete pass, so a
  // failed pass retries. (Upgrading from 0.5.1, which saved no list, is the
  // scanner revision bump's job; an install whose scope is unanswered sends
  // none of these fields yet, and its answer marks the re-send itself.)
  if (config.scopeDecidedAt && known && RESEND_ON_GAIN.some((f) => served.fields.has(f) && !known.includes(f)) && !config.pendingBackfill) {
    config.pendingBackfill = true;
    await writeConfig(config);
  }
  if (versionsChanged || !known || JSON.stringify(capsNow) !== JSON.stringify(known)) {
    state.capabilities = capsNow;
    await writeState(state);
  }
  if (served.cli?.minimum && isOlder(at.version, served.cli.minimum)) throw new CliOutdatedError(await parkOutdated(served.cli.minimum));
  const notice = state.updateNotice?.version === at.version ? state.updateNotice : undefined;
  // Under the sync lock; hook appends are line-atomic. A compaction that
  // fails (a file Windows will not let go of) leaves the sidecar long, not
  // the sync undone.
  await compactSidecar().catch(() => {});
  await learnConfigDirs();
  const resolver = await IdentityResolver.create(installId);
  const placer = new Placer(resolver);
  const minOccurredAt = new Date("2020-01-01T00:00:00.000Z");
  const maxOccurredAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  let grandInserted = 0;
  let grandSkipped = 0;
  let grandInbox = 0;
  let grandHeldElsewhere = 0;
  // Held events read on a full pass: the history a moved machine left with
  // its first account. An incremental pass re-reads a day of overlap, which
  // after a move is that account's too; repeating it every sync is noise.
  let heldOnFullRead = 0;
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
    if (scanner.requiresSurfaceCapability && (!caps.surfaces?.has(scanner.surface) || !caps.fields.has("billing-route"))) {
      progress(`${scanner.surface}: waiting for server support; local logs were not read`);
      continue;
    }
    // Each surface keeps its own watermark so a scanner added in an upgrade
    // backfills its full history instead of inheriting another's cutoff.
    const mark = full ? undefined : sinceForSurface(state, scanner.surface, scanner.revision);
    if (mark) anyWatermark = true;
    const since = mark ? new Date(mark.getTime() - WATERMARK_OVERLAP_MS) : undefined;
    const scanStartedAt = new Date();
    const reading = `${scanner.surface}: reading logs ${since ? `since ${since.toISOString().slice(0, 10)}` : "(full history)"}`;
    progressStatus(`${reading}…`);
    // A recently changed file can contain newly discovered or corrected old
    // usage. Read and place its whole history, then replay every in-scope
    // event through idempotent ingest. Event time is not a delivery cursor;
    // the scanner's context marker only describes the timestamp window.
    const scanned = await scanner.scan({
      since,
      wholeFiles: true,
      onFile: (done, total) =>
        progressStatus(`${reading} — ${done.toLocaleString("en-US")}/${total.toLocaleString("en-US")} files`),
    });
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
    progressStatus(`${scanner.surface}: finding the repo of ${scanned.length.toLocaleString("en-US")} events…`);
    await placer.place(scanned);
    const events = candidates.filter((e) => eventInScope(e, config));
    heldByScope += candidates.length - events.length;
    if (events.length === 0) {
      progress(`${scanner.surface}: nothing new${candidates.length > 0 ? ` (${candidates.length.toLocaleString("en-US")} held back by scope)` : ""}`);
      await stampSurface(state, scanner.surface, scanner.revision, scanStartedAt);
      continue;
    }
    anyEvents = true;
    if (scanner.surface === "claude-code" || scanner.surface === "codex") {
      for (const e of events) attributionEvents.push(e);
    }

    let surfaceInserted = 0;
    let surfaceSkipped = 0;
    let surfaceHeld = 0;
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);
      progressStatus(`${scanner.surface}: sending ${Math.min(i + BATCH_SIZE, events.length).toLocaleString("en-US")} of ${events.length.toLocaleString("en-US")} events`);
      const body = {
        source: { surface: scanner.surface, kind: "local_logs" },
        events: batch.map((e) => toWireEvent(e, caps, config, installId, scanner.surface)),
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
      if (res.status === 401) await disconnect(await refusalReason(res));
      // Refused before the token is looked at: an outdated install stays paired.
      if (res.status === 426) throw new CliOutdatedError(await parkOutdated((await minimumFrom(res)) ?? served.cli?.minimum));
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(
          `Sync failed for ${scanner.surface} (${res.status})${b?.error ? `: ${b.error}` : ""}`,
        );
      }
      const result = (await res.json()) as IngestResponse;
      // Accepted: a park this install left (a 426 seen when the server could
      // not be asked for its minimum) no longer holds; written with the stamp.
      if (state.outdated && sameInstall(state.outdated, at)) delete state.outdated;
      grandInserted += result.inserted;
      grandSkipped += result.skipped;
      grandInbox += result.inboxCount;
      const held = typeof result.heldElsewhere === "number" && result.heldElsewhere > 0 ? Math.min(result.heldElsewhere, result.skipped) : 0;
      grandHeldElsewhere += held;
      surfaceInserted += result.inserted;
      surfaceSkipped += result.skipped - held;
      surfaceHeld += held;
    }
    progress(
      `${scanner.surface}: ${surfaceInserted.toLocaleString("en-US")} new, ${surfaceSkipped.toLocaleString("en-US")} already synced` +
        (surfaceHeld > 0 ? `, ${surfaceHeld.toLocaleString("en-US")} with another account` : ""),
    );

    if (!since) heldOnFullRead += surfaceHeld;

    // Only after every batch for this surface landed; a failure above throws
    // and leaves this surface's watermark where it was.
    await stampSurface(state, scanner.surface, scanner.revision, scanStartedAt);
  }

  if (config.pendingBackfill) {
    config.pendingBackfill = false; // every enabled surface got its full pass above
    await writeConfig(config);
  }

  if (!anyEvents) {
    progressDone();
    if (heldByScope > 0) {
      console.log(`Nothing in scope to sync — ${heldByScope} event(s) held back by your scope (see \`centrail repos\`).`);
    } else {
      console.log(
        anyWatermark
          ? "No new events since the last sync."
          : "No agent usage found (Claude Code, Copilot CLI, Codex).",
      );
    }
    if (notice) progress(updateNoticeLine(notice));
    return;
  }

  if (attributionEvents.length > 0) {
    progressStatus("Matching events to commits…");
    await pushAttributions(auth, attributionEvents, resolver, config, caps, installId);
  }

  progressDone();
  console.log(
    `Inserted ${grandInserted} · Skipped ${grandSkipped - grandHeldElsewhere}` +
      // Projects are optional (2026-10 IA): a neutral count, not a queue to work.
      (grandInbox > 0 ? ` · ${grandInbox} not in a project` : "") +
      (heldByScope > 0 ? ` · ${heldByScope} held back by scope` : ""),
  );
  if (heldOnFullRead > 0) console.log(heldElsewhereLine(heldOnFullRead));
  if (notice) progress(updateNoticeLine(notice));
}

export function heldElsewhereLine(n: number): string {
  return n === 1
    ? "1 event was already synced from this machine to another account; it stays there."
    : `${n.toLocaleString("en-US")} events were already synced from this machine to another account; they stay there.`;
}

// The server refused this machine's token: park it, so the Stop hook stops
// starting syncs that can only fail, and say why in one line.
async function disconnect(reason: DisconnectReason): Promise<never> {
  progressDone();
  await parkAuth(reason);
  throw new Error(disconnectedMessage({ at: new Date().toISOString(), reason }));
}

function accountLabel(auth: AuthConfig, fresh?: { email: string }): string {
  const email = fresh?.email ?? auth.account?.email;
  return email ? ` as ${email}` : "";
}

// A hook run with a scrubbed environment (CLAUDE_CODE_SUBPROCESS_ENV_SCRUB)
// spawns a sync that cannot see CLAUDE_CONFIG_DIR, so a relocated config
// dir would never be scanned. The hook recorded each transcript's path;
// every config dir those paths live under joins the scan.
async function learnConfigDirs(): Promise<void> {
  const known = claudeConfigDirs();
  const learned: string[] = [];
  for (const line of (await readSidecar()).values()) {
    if (line.surface !== "claude-code" || !line.transcript) continue;
    const i = line.transcript.replace(/\\/g, "/").lastIndexOf("/projects/"); // same length: i indexes the original
    if (i <= 0) continue;
    const dir = line.transcript.slice(0, i);
    if (!known.includes(dir) && !learned.includes(dir)) learned.push(dir);
  }
  if (learned.length > 0) process.env.CLAUDE_CONFIG_DIR = [...known, ...learned].join(",");
}

async function stampSurface(
  state: SyncState,
  surface: string,
  revision: number,
  scanStartedAt: Date,
): Promise<void> {
  stampWatermark(state, surface, revision, scanStartedAt);
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
  installId: string,
): Promise<void> {
  const identityAware = caps.fields.has("repo");
  // § 3.8: a server that advertises "match" attributes events to commits
  // itself, from the facts on the fate rows — every still-unattributed event
  // of the repo key, no 24 h window, any machine. The CLI then declares its
  // repos with the fates and computes no attributions at all.
  const serverMatches = identityAware && caps.fields.has("match");

  // One bucket per (checkout root, ref). A live checkout reads its own HEAD
  // log, as before. A session whose folder is gone joins a live checkout of
  // the same identity and reads the branch its sidecar line recorded —
  // branches outlive worktrees — or every ref when it was detached. A
  // bucket's name and key are what the wire carries (wireRepoRef: hidden
  // under hideRepoNames); the plaintext key only finds checkouts.
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
    const shown = wireRepoRef(repo, config, installId);
    bucket(root, "HEAD", shown.name, shown.key).events.push(e);
  }
  const rootByKey = new Map<string, string>();
  for (const b of buckets.values()) if (!rootByKey.has(b.key)) rootByKey.set(b.key, b.root);
  for (const e of orphans) {
    const repo = e.metadata.repo!;
    const shown = wireRepoRef(repo, config, installId);
    let root = rootByKey.get(shown.key);
    if (!root) {
      // No event's cwd is a live checkout of this key; the hook may still
      // know one (a root it recorded, or the main checkout of a dead worktree).
      const found = await resolver.liveRootForKey(repo.key);
      if (!found) continue; // no live checkout on this machine: usage ships, commits wait
      rootByKey.set(shown.key, (root = found));
    }
    const branch = resolver.sidecarBranchFor(e);
    bucket(root, branch ? `refs/heads/${branch}` : "--all", shown.name, shown.key).events.push(e);
  }
  if (buckets.size === 0) return;

  const repos: { name: string; key?: string; totalLoc: number | null; fileCount: number }[] = [];
  const attributions: WireAttribution[] = [];
  const sizedRoots = new Set<string>();

  for (const { root, ref, name, key, events: repoEvents } of buckets.values()) {
    const commits = serverMatches ? [] : await readRepoCommits(root, ref);
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

    if (serverMatches) continue;
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
        branch: wireBranch(branchByExternalId.get(m.externalId), config),
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
        if (res.status === 426) throw new CliOutdatedError(await parkOutdated(await minimumFrom(res)));
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
      if (err instanceof CliOutdatedError) throw err; // best-effort, but not past a refused version
      console.warn("  ⚠ Attribution request failed:", (err as Error).message);
    }
  }

  // Fate pass: recompute shipped / in_flight / unshipped for every recent sha
  // in each resolved repo. Repos without a resolvable default branch are
  // skipped inside runFatePass (never guess); when none pass, no line prints.
  // One fact set per KEY: two live clones of one repo on this machine each
  // hold commits the other has not fetched, and a complete set from one of
  // them would read the other's as vanished. Their facts are unioned.
  const fateRepos = new Map<string, { roots: string[]; name: string; key?: string }>();
  for (const b of buckets.values()) {
    const id = identityAware ? b.key : b.root;
    const entry = fateRepos.get(id);
    if (!entry) fateRepos.set(id, { roots: [b.root], name: b.name, key: identityAware ? b.key : undefined });
    else if (!entry.roots.includes(b.root)) entry.roots.push(b.root);
  }
  const tally = await runFatePass(auth, [...fateRepos.values()], serverMatches ? repos : [], identityAware ? installId : undefined, caps, config);
  if (tally) {
    console.log(`  ↳ ${formatShipStatusLine(tally)}`);
  }
}
