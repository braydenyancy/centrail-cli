// Per-surface sync watermarks. Before 0.4.1 one shared `lastSyncAt` covered
// every scanner, so a NEWLY ADDED scanner inherited a watermark that never
// covered it and silently skipped its whole history unless the user ran
// `sync --full`. Each surface now keeps its own watermark; the shared one is
// frozen and only read as a fallback for the surfaces that existed under it.

export type SyncState = {
  lastSyncAt: string | null; // pre-0.4.1 shared watermark; frozen, read-only
  surfaces: Record<string, string>; // surface -> ISO time of its last successful sync
  scannerRevisions: Record<string, number>; // surface -> discovery logic revision
  autoSyncAt?: string; // last time the Stop hook started a background sync
  capabilities?: string[]; // the last `fields` the server advertised; used when it cannot be asked
};

// The scanner registry as of the last release with the shared watermark
// (0.4.0). Frozen forever: any surface added later must NOT inherit
// `lastSyncAt`, so its first sync backfills full history automatically.
const SHARED_WATERMARK_SURFACES = new Set(["claude-code", "copilot-cli", "codex"]);

export function parseSyncState(raw: unknown): SyncState {
  const obj = isObject(raw) ? raw : {};
  const surfaces: Record<string, string> = {};
  if (isObject(obj.surfaces)) {
    for (const [surface, value] of Object.entries(obj.surfaces)) {
      if (typeof value === "string") surfaces[surface] = value;
    }
  }
  const scannerRevisions: Record<string, number> = {};
  if (isObject(obj.scannerRevisions)) {
    for (const [surface, value] of Object.entries(obj.scannerRevisions)) {
      if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        scannerRevisions[surface] = value;
      }
    }
  }
  return {
    lastSyncAt: typeof obj.lastSyncAt === "string" ? obj.lastSyncAt : null,
    surfaces,
    scannerRevisions,
    ...(typeof obj.autoSyncAt === "string" ? { autoSyncAt: obj.autoSyncAt } : {}),
    ...(Array.isArray(obj.capabilities) ? { capabilities: obj.capabilities.filter((f): f is string => typeof f === "string") } : {}),
  };
}

// Two CLIs can sync one machine: a global 0.5.1 install beside `npx
// centrail`, or a plugin hook whose bundle is a release behind. Each stamps
// the surface's watermark with its own scanner revision, so the newer one
// read the older stamp as "never completed at my revision" and re-sent the
// whole history on every sync. Nor can it simply trust the older stamp: the
// older scanner sent what it found in its older shape. So each pass also
// keeps its own mark per revision, `surfaces["<surface>@<revision>"]`:
// every CLI since 0.4.1 rewrites state.json from the fields it knows, and
// `surfaces` is the one map they all carry through whole.
export function sinceForSurface(
  state: SyncState,
  surface: string,
  scannerRevision = 1,
): Date | undefined {
  // A scanner revision means previously undiscovered historical events may
  // exist below an old watermark. Missing revision data is revision 1 for
  // compatibility with state files written before this field existed.
  let since: Date | undefined;
  const completedRevision = state.scannerRevisions[surface] ?? 1;
  if (completedRevision >= scannerRevision) {
    const own = state.surfaces[surface];
    if (own) since = validDate(own);
    else if (state.lastSyncAt && SHARED_WATERMARK_SURFACES.has(surface)) since = validDate(state.lastSyncAt);
  }
  // A pass at this revision or a later one sent everything this scanner
  // finds up to its mark, whatever stamped over it since.
  for (const [key, iso] of Object.entries(state.surfaces)) {
    const revision = markRevision(key, surface);
    if (revision === undefined || revision < scannerRevision) continue;
    const mark = validDate(iso);
    if (mark && (!since || mark > since)) since = mark;
  }
  return since;
}

// A completed pass: the shared watermark, which every CLI reads, and this
// revision's own mark, which an older CLI's stamp leaves alone.
export function stampWatermark(state: SyncState, surface: string, revision: number, at: Date): void {
  state.surfaces[surface] = at.toISOString();
  state.scannerRevisions[surface] = revision;
  state.surfaces[`${surface}@${revision}`] = at.toISOString();
}

function markRevision(key: string, surface: string): number | undefined {
  if (!key.startsWith(`${surface}@`)) return undefined;
  const revision = Number(key.slice(surface.length + 1));
  return Number.isInteger(revision) && revision > 0 ? revision : undefined;
}

function validDate(iso: string): Date | undefined {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
