import { describe, expect, it } from "vitest";
import type { ParsedUsageEvent } from "@centrail/parsers";
import { toWireUsageEvent } from "./wire.js";

describe("toWireUsageEvent", () => {
  it("uploads only the explicit usage allowlist", () => {
    const localEvent: ParsedUsageEvent = {
      externalId: "req_001",
      provider: "anthropic",
      model: "claude-fable-5-1",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      cacheWriteTokens: 40,
      cacheCreation5mTokens: 15,
      cacheCreation1hTokens: 25,
      occurredAt: new Date("2026-09-28T12:00:00.000Z"),
      metadata: {
        cwd: "/Users/private/company/secret-project",
        gitBranch: "person/secret-feature",
        sessionId: "session-private",
        version: "9.9.9",
        entrypoint: "private-client",
        origin: {
          host: "person-laptop",
          platform: "darwin",
          client: "private-client",
          clientVersion: "9.9.9",
        },
      },
    };

    expect(toWireUsageEvent(localEvent)).toEqual({
      externalId: "req_001",
      model: "claude-fable-5-1",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      cacheWriteTokens: 40,
      cacheCreation5mTokens: 15,
      cacheCreation1hTokens: 25,
      occurredAt: "2026-09-28T12:00:00.000Z",
    });

    const json = JSON.stringify(toWireUsageEvent(localEvent));
    for (const privateValue of [
      "anthropic",
      "/Users/private",
      "secret-feature",
      "session-private",
      "person-laptop",
      "darwin",
      "private-client",
    ]) {
      expect(json).not.toContain(privateValue);
    }
  });

  it("preserves an unfamiliar future model name without an allowlist", () => {
    const event = {
      externalId: "future-1",
      provider: "unknown",
      model: "vendor-model-next-2099",
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      occurredAt: new Date("2026-09-28T12:00:00.000Z"),
      metadata: {},
    } satisfies ParsedUsageEvent;

    expect(toWireUsageEvent(event).model).toBe("vendor-model-next-2099");
  });
});
