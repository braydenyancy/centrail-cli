// Per-surface sync watermarks. Before 0.4.1 one shared `lastSyncAt` covered
// every scanner, so a NEWLY ADDED scanner inherited a watermark that never
// covered it and silently skipped its whole history unless the user ran
// `sync --full`. Each surface now keeps its own watermark; the shared one is
// frozen and only read as a fallback for the surfaces that existed under it.

export type SyncState = {
  lastSyncAt: string | null; // pre-0.4.1 shared watermark; frozen, read-only
  surfaces: Record<string, string>; // surface -> ISO time of its last successful sync
  scannerRevisions: Record<string, number>; // surface -> discovery logic revision
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
  };
}

export function sinceForSurface(
  state: SyncState,
  surface: string,
  scannerRevision = 1,
): Date | undefined {
  // A scanner revision means previously undiscovered historical events may
  // exist below an old watermark. Missing revision data is revision 1 for
  // compatibility with state files written before this field existed.
  const completedRevision = state.scannerRevisions[surface] ?? 1;
  if (completedRevision < scannerRevision) return undefined;
  const own = state.surfaces[surface];
  if (own) return validDate(own);
  if (state.lastSyncAt && SHARED_WATERMARK_SURFACES.has(surface)) {
    return validDate(state.lastSyncAt);
  }
  return undefined;
}

function validDate(iso: string): Date | undefined {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
