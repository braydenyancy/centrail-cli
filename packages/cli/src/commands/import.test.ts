// `centrail import <ccusage.json>`: a ccusage export becomes Measured-tier
// history on the server (decision § 3.6), never certified rows. Written
// before the command: what a row is, and what is refused.
import { describe, expect, it } from "vitest";
import { parseCcusageExport } from "./import.js";

const daily = {
  daily: [
    { date: "2026-07-24", inputTokens: 10, outputTokens: 20, cacheReadTokens: 100, cacheCreationTokens: 30, modelBreakdowns: [{ modelName: "claude-opus-4-8", inputTokens: 10, outputTokens: 20, cacheReadTokens: 100, cacheCreationTokens: 30, cost: 1 }], modelsUsed: ["claude-opus-4-8"], totalCost: 1, totalTokens: 160 },
    { date: "2026-07-25", inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheCreationTokens: 6, modelBreakdowns: [
      { modelName: "claude-opus-4-8", inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, cost: 1 },
      { modelName: "claude-sonnet-5", inputTokens: 2, outputTokens: 2, cacheReadTokens: 2, cacheCreationTokens: 2, cost: 1 },
    ], modelsUsed: ["claude-opus-4-8", "claude-sonnet-5"], totalCost: 2, totalTokens: 18 },
  ],
  totals: {},
};

describe("parseCcusageExport", () => {
  it("daily: one row per day and model, context = cache read + cache creation", () => {
    expect(parseCcusageExport(daily)).toEqual([
      { day: "2026-07-24", model: "claude-opus-4-8", inputTokens: 10, outputTokens: 20, contextTokens: 130 },
      { day: "2026-07-25", model: "claude-opus-4-8", inputTokens: 1, outputTokens: 2, contextTokens: 7 },
      { day: "2026-07-25", model: "claude-sonnet-5", inputTokens: 2, outputTokens: 2, contextTokens: 4 },
    ]);
  });

  it("session: rows land on the day of the session's last activity (UTC), merged per day and model", () => {
    const sessions = {
      sessions: [
        { sessionId: "a", projectPath: "-home-x", firstActivity: "2026-08-19T06:58:14.255Z", lastActivity: "2026-09-03T23:59:59.000Z", modelBreakdowns: [{ modelName: "m", inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, cost: 0 }] },
        { sessionId: "b", projectPath: "-home-y", firstActivity: "2026-09-03T00:00:00.000Z", lastActivity: "2026-09-03T01:00:00.000Z", modelBreakdowns: [{ modelName: "m", inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40, cost: 0 }] },
      ],
      totals: {},
    };
    expect(parseCcusageExport(sessions)).toEqual([{ day: "2026-09-03", model: "m", inputTokens: 11, outputTokens: 22, contextTokens: 77 }]);
  });

  it.each([
    ["not an object", 42],
    ["neither daily nor sessions", { totals: {} }],
    ["a daily row without a date", { daily: [{ modelBreakdowns: [] }] }],
    ["a date that is not a day", { daily: [{ date: "2026-7-1", modelBreakdowns: [] }] }],
    ["a breakdown without a model", { daily: [{ date: "2026-07-01", modelBreakdowns: [{ inputTokens: 1 }] }] }],
    ["a negative count", { daily: [{ date: "2026-07-01", modelBreakdowns: [{ modelName: "m", inputTokens: -1 }] }] }],
    ["a fractional count", { daily: [{ date: "2026-07-01", modelBreakdowns: [{ modelName: "m", inputTokens: 1.5 }] }] }],
    ["a session without lastActivity", { sessions: [{ modelBreakdowns: [{ modelName: "m" }] }] }],
  ])("refuses %s", (_, json) => {
    expect(() => parseCcusageExport(json)).toThrow(/ccusage/);
  });

  it("missing counts read as zero; a day with no breakdown yields no row; a model name is trimmed to 100 chars", () => {
    const rows = parseCcusageExport({ daily: [{ date: "2026-07-01", modelBreakdowns: [{ modelName: "x".repeat(150) }] }, { date: "2026-07-02", modelBreakdowns: [] }] });
    expect(rows).toEqual([{ day: "2026-07-01", model: "x".repeat(100), inputTokens: 0, outputTokens: 0, contextTokens: 0 }]);
  });
});
