import { describe, expect, it } from "vitest";
import {
  parseSyncState,
  sinceForSurface,
  stampWatermark,
  type SyncState,
} from "./watermarks.js";

describe("parseSyncState", () => {
  it("reads per-surface watermarks and the legacy shared one", () => {
    expect(
      parseSyncState({
        lastSyncAt: "2026-07-01T00:00:00.000Z",
        surfaces: { codex: "2026-07-10T00:00:00.000Z", junk: 5 },
        scannerRevisions: { codex: 2, broken: 0, junk: "3" },
      }),
    ).toEqual({
      lastSyncAt: "2026-07-01T00:00:00.000Z",
      surfaces: { codex: "2026-07-10T00:00:00.000Z" },
      scannerRevisions: { codex: 2 },
    });
  });

  it("defaults cleanly for pre-0.4.1 and malformed state", () => {
    expect(parseSyncState({ lastSyncAt: "2026-07-01T00:00:00.000Z" })).toEqual({
      lastSyncAt: "2026-07-01T00:00:00.000Z",
      surfaces: {},
      scannerRevisions: {},
    });
    expect(parseSyncState(null)).toEqual({
      lastSyncAt: null,
      surfaces: {},
      scannerRevisions: {},
    });
    expect(parseSyncState({ lastSyncAt: 42, surfaces: "nope" })).toEqual({
      lastSyncAt: null,
      surfaces: {},
      scannerRevisions: {},
    });
  });
});

describe("sinceForSurface", () => {
  const legacyOnly = {
    lastSyncAt: "2026-07-01T00:00:00.000Z",
    surfaces: {},
    scannerRevisions: {},
  };

  it("prefers the surface's own watermark", () => {
    const state: SyncState = {
      lastSyncAt: "2026-07-01T00:00:00.000Z",
      surfaces: { codex: "2026-07-10T00:00:00.000Z" },
      scannerRevisions: {},
    };
    expect(sinceForSurface(state, "codex")?.toISOString()).toBe(
      "2026-07-10T00:00:00.000Z",
    );
  });

  it("lets pre-0.4.1 surfaces inherit the legacy shared watermark", () => {
    for (const surface of ["claude-code", "copilot-cli", "codex"]) {
      expect(sinceForSurface(legacyOnly, surface)?.toISOString()).toBe(
        "2026-07-01T00:00:00.000Z",
      );
    }
  });

  it("gives a surface the legacy watermark never covered a full backfill", () => {
    // The 0.4.0 bug: a new scanner inherited the shared watermark and silently
    // skipped its entire history unless the user knew to run --full.
    expect(sinceForSurface(legacyOnly, "gemini-cli")).toBeUndefined();
  });

  it("backfills once when a scanner's discovery revision increases", () => {
    const state: SyncState = {
      lastSyncAt: null,
      surfaces: { "claude-code": "2026-09-20T00:00:00.000Z" },
      scannerRevisions: {},
    };
    expect(sinceForSurface(state, "claude-code", 2)).toBeUndefined();

    state.scannerRevisions["claude-code"] = 2;
    expect(sinceForSurface(state, "claude-code", 2)?.toISOString()).toBe(
      "2026-09-20T00:00:00.000Z",
    );
  });

  it("returns undefined when there is no watermark at all", () => {
    expect(
      sinceForSurface(
        { lastSyncAt: null, surfaces: {}, scannerRevisions: {} },
        "codex",
      ),
    ).toBeUndefined();
  });

  it("ignores an unparseable watermark instead of producing Invalid Date", () => {
    expect(
      sinceForSurface(
        {
          lastSyncAt: null,
          surfaces: { codex: "garbage" },
          scannerRevisions: {},
        },
        "codex",
      ),
    ).toBeUndefined();
  });
});

// Two CLIs on one machine, each stamping its own scanner revision over the
// other's. What an older one does to state.json is frozen in its release:
// 0.5.1 rewrites the fields it knows (lastSyncAt, surfaces,
// scannerRevisions) and stamps its revision; 0.5.0 and earlier drop
// scannerRevisions altogether.
describe("an older CLI stamping between two newer passes", () => {
  const T1 = new Date("2026-10-01T00:00:00.000Z"); // the newer CLI's last pass, at revision 3
  const T2 = new Date("2026-10-06T00:00:00.000Z"); // the older one's, since
  const newerPass = (): SyncState => {
    const state: SyncState = { lastSyncAt: null, surfaces: {}, scannerRevisions: {} };
    stampWatermark(state, "claude-code", 3, T1);
    return state;
  };
  // What a CLI of that release writes back, applied to the file as it reads it.
  const as051 = (s: SyncState): SyncState => {
    const read = parseSyncState(JSON.parse(JSON.stringify(s)));
    read.surfaces["claude-code"] = T2.toISOString();
    read.scannerRevisions["claude-code"] = 2;
    return { lastSyncAt: read.lastSyncAt, surfaces: read.surfaces, scannerRevisions: read.scannerRevisions };
  };
  const as050 = (s: SyncState): SyncState =>
    parseSyncState({ lastSyncAt: s.lastSyncAt, surfaces: { ...s.surfaces, "claude-code": T2.toISOString() } });

  it("the newer one resumes from its own pass: not the whole history, and not the older one's later mark", () => {
    // Not T2: what 0.5.1 sent since T1 went in its older shape, and the
    // newer scanner re-sends it once, from T1. Not undefined: that was a
    // full re-send on every newer sync, for as long as both kept running.
    expect(sinceForSurface(as051(newerPass()), "claude-code", 3)).toEqual(T1);
    expect(sinceForSurface(as050(newerPass()), "claude-code", 3)).toEqual(T1);
  });

  it("the older one still reads the shared watermark, and its own revision goes on the record", () => {
    const state = newerPass();
    expect(sinceForSurface(state, "claude-code", 2)).toEqual(T1);
    expect(state.scannerRevisions["claude-code"]).toBe(3);
    stampWatermark(state, "claude-code", 2, T2); // an older revision that also keeps marks
    expect(state.scannerRevisions["claude-code"]).toBe(2); // the shared stamp says honestly who scanned last
    expect(sinceForSurface(state, "claude-code", 3)).toEqual(T1);
    expect(sinceForSurface(state, "claude-code", 2)).toEqual(T2);
  });

  it("a later revision's pass counts for an earlier scanner; an earlier one's never for a later", () => {
    const state: SyncState = { lastSyncAt: null, surfaces: {}, scannerRevisions: {} };
    stampWatermark(state, "claude-code", 4, T2);
    stampWatermark(state, "claude-code", 2, T1);
    expect(sinceForSurface(state, "claude-code", 3)).toEqual(T2);
    expect(sinceForSurface(state, "claude-code", 5)).toBeUndefined();
    expect(sinceForSurface(state, "codex", 1)).toBeUndefined(); // another surface's marks are not this one's
  });

  it("forgetting the watermarks (an account switch) forgets the marks too", () => {
    const state = newerPass();
    state.surfaces = {}; // connect's forgetWatermarks
    expect(sinceForSurface(state, "claude-code", 3)).toBeUndefined();
  });
});
