import { describe, expect, it } from "vitest";
import { parseSyncState, sinceForSurface } from "./watermarks.js";

describe("parseSyncState", () => {
  it("reads per-surface watermarks and the legacy shared one", () => {
    expect(
      parseSyncState({
        lastSyncAt: "2026-07-01T00:00:00.000Z",
        surfaces: { codex: "2026-07-10T00:00:00.000Z", junk: 5 },
      }),
    ).toEqual({
      lastSyncAt: "2026-07-01T00:00:00.000Z",
      surfaces: { codex: "2026-07-10T00:00:00.000Z" },
    });
  });

  it("defaults cleanly for pre-0.4.1 and malformed state", () => {
    expect(parseSyncState({ lastSyncAt: "2026-07-01T00:00:00.000Z" })).toEqual({
      lastSyncAt: "2026-07-01T00:00:00.000Z",
      surfaces: {},
    });
    expect(parseSyncState(null)).toEqual({ lastSyncAt: null, surfaces: {} });
    expect(parseSyncState({ lastSyncAt: 42, surfaces: "nope" })).toEqual({
      lastSyncAt: null,
      surfaces: {},
    });
  });
});

describe("sinceForSurface", () => {
  const legacyOnly = { lastSyncAt: "2026-07-01T00:00:00.000Z", surfaces: {} };

  it("prefers the surface's own watermark", () => {
    const state = {
      lastSyncAt: "2026-07-01T00:00:00.000Z",
      surfaces: { codex: "2026-07-10T00:00:00.000Z" },
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

  it("returns undefined when there is no watermark at all", () => {
    expect(sinceForSurface({ lastSyncAt: null, surfaces: {} }, "codex")).toBeUndefined();
  });

  it("ignores an unparseable watermark instead of producing Invalid Date", () => {
    expect(
      sinceForSurface({ lastSyncAt: null, surfaces: { codex: "garbage" } }, "codex"),
    ).toBeUndefined();
  });
});
