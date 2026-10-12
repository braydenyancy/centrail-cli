import { describe, expect, it, vi, afterEach } from "vitest";
import type { ParsedUsageEvent } from "@centrail/parsers";
import type { Config } from "./config.js";
import { consentedCapabilities, readCapabilities, toWireEvent } from "./wire.js";

const cfg = { scopeDecidedAt: "2026-10-08", hideRepoNames: true, hideBranchNames: true } as Config;
const caps = { fields: new Set(["repo", "billing-route"]), surfaces: new Set(["pi", "gemini-cli"]) };
const event = (provider = "openai"): ParsedUsageEvent => ({
  externalId: "pi:request", provider, model: "gpt-5", inputTokens: 10, outputTokens: 5,
  cacheReadTokens: 0, cacheCreationTokens: 0, cacheWriteTokens: 0,
  cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, occurredAt: new Date("2026-10-08T00:00:00Z"),
  metadata: { sessionId: "pi:session-1", cwd: "/private/company", gitBranch: "secret-branch" },
});

afterEach(() => vi.unstubAllGlobals());

describe("new source billing routes and session continuity", () => {
  it.each(["openai", "anthropic", "openrouter", "azure", "openai-codex"])("preserves bounded observed route %s", (provider) => {
    expect(toWireEvent(event(provider), caps, cfg, "install", "pi").billingProvider).toBe(provider);
  });
  it("does not infer Gemini's auth/endpoint from its model maker", () => {
    expect(toWireEvent(event("google"), caps, cfg, "install", "gemini-cli").billingProvider).toBe("unknown");
  });
  it("does not transmit a custom endpoint or account-shaped provider", () => {
    const wire = toWireEvent(event("https://private:password@api.example"), caps, cfg, "install", "pi");
    expect(wire.billingProvider).toBe("unknown");
    expect(JSON.stringify(wire)).not.toContain("password");
  });
  it("does not change old surfaces' provider identity", () => {
    expect(toWireEvent(event("azure"), caps, cfg, "install", "codex")).not.toHaveProperty("billingProvider");
  });
  it("sends observed service class without inventing one", () => {
    expect(toWireEvent(event(), caps, cfg, "install", "pi")).not.toHaveProperty("serviceClass");
    expect(toWireEvent({ ...event(), serviceClass: "priority" }, caps, cfg, "install", "pi").serviceClass).toBe("priority");
  });
  it.each(["PRIVATE_ENDPOINT", "", 42, null])("does not leak or price an invalid runtime service class %j", (serviceClass) => {
    const parsed = { ...event(), serviceClass } as unknown as ParsedUsageEvent;
    const wire = toWireEvent(parsed, caps, cfg, "install", "pi");
    expect(wire.serviceClass).toBe("unknown");
    expect(JSON.stringify(wire)).not.toContain("PRIVATE_ENDPOINT");
  });
  it("retains consented session identity while hiding repo/branch names", () => {
    const wire = toWireEvent(event(), caps, cfg, "install", "pi");
    expect(wire.metadata?.sessionId).toBe("pi:session-1");
    expect(wire.metadata).not.toHaveProperty("gitBranch");
    expect(JSON.stringify(wire)).not.toContain("/private");
  });
  it("does not add session or billing metadata before the scope answer", () => {
    const allowed = consentedCapabilities(caps, { scopeDecidedAt: null });
    const wire = toWireEvent(event(), allowed, cfg, "install", "pi");
    expect(allowed.surfaces).toBeUndefined();
    expect(wire).not.toHaveProperty("metadata");
    expect(wire).not.toHaveProperty("billingProvider");
  });
  it("reads bounded server surface names without changing legacy responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ fields: ["repo"], surfaces: ["pi", null, 2] }) }));
    expect((await readCapabilities({ baseUrl: "https://example.test" })).surfaces).toEqual(new Set(["pi"]));
  });
});
