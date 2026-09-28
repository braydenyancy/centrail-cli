import { describe, expect, it } from "vitest";
import {
  parseSyncState,
  sinceForSurface,
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
