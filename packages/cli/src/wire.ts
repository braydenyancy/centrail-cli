import { createHmac } from "node:crypto";
import type { ParsedUsageEvent, Placement, RepoIdentity } from "@centrail/parsers";
import type { Config } from "./config.js";
import { versionHeaders } from "./version.js";

// The parser event contains local-only context used for Git attribution.
// Keep the network shape separate and explicit so a parser field can never
// become an upload merely because it was added to ParsedUsageEvent.
export type WireUsageEvent = {
  externalId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheWriteTokens?: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  occurredAt: string;
};

export function toWireUsageEvent(event: ParsedUsageEvent): WireUsageEvent {
  return {
    externalId: event.externalId,
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheCreationTokens: event.cacheCreationTokens,
    ...(event.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: event.cacheWriteTokens }),
    cacheCreation5mTokens: event.cacheCreation5mTokens,
    cacheCreation1hTokens: event.cacheCreation1hTokens,
    occurredAt: event.occurredAt.toISOString(),
  };
}

// What the deployed server accepts beyond the 0.5.1 allowlist. Read once per
// sync from /api/cli/capabilities. Server first, CLI second, tag last
// (CONTRACT.md § Release ordering); an unreachable or older server reads as
// "nothing extra", which is exactly the 0.5.1 wire.
export type Capabilities = { fields: Set<string> };

export async function readCapabilities(auth: { baseUrl: string }): Promise<Capabilities> {
  try {
    const res = await fetch(`${auth.baseUrl}/api/cli/capabilities`, {
      headers: versionHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { fields: new Set() };
    const body = (await res.json()) as { fields?: unknown };
    const fields = Array.isArray(body.fields)
      ? body.fields.filter((f): f is string => typeof f === "string")
      : [];
    return { fields: new Set(fields) };
  } catch {
    return { fields: new Set() };
  }
}

// The identity block an identity-aware server receives. Every field named.
export type WireRepoIdentity = { key: string; label: string; source: RepoIdentity["source"] };

// Extends the 0.5.1 allowlist, and only for a server that lists "repo".
export type WireEventMetadata = {
  repo?: WireRepoIdentity;
  placement?: Placement; // how `repo` was chosen (§ 3.9); only ever next to it
  sessionId?: string;
  gitBranch?: string;
  origin: { machineId: string }; // the random install id; never the hostname
};

export type WireEvent = WireUsageEvent & { metadata?: WireEventMetadata };

// The field policy, applied in one place so `centrail inspect --last` shows
// exactly what this function produced. Every field is named: nothing on the
// parsed event reaches the wire by being spread.
//   - every server: the 0.5.1 allowlist (toWireUsageEvent)
//   - a server that lists "repo": repo identity, session id, branch, and a
//     random per-install id
//   - never: working-directory paths, hostnames, platform, account data
//   - placement tag (§ 3.9): shipped with the identity, as its disclaimer
//   - touched paths and turn ids: never; they exist to choose the repo
//   - hideRepoNames / hideBranchNames: user toggles, applied here
export function toWireEvent(
  e: ParsedUsageEvent,
  caps: Capabilities,
  cfg: Config,
  installId: string,
): WireEvent {
  const usage = toWireUsageEvent(e);
  if (!caps.fields.has("repo")) return usage;
  const metadata: WireEventMetadata = { origin: { machineId: installId } };
  if (e.metadata.repo) {
    metadata.repo = wireIdentity(redactIdentity(e.metadata.repo, cfg, installId));
    if (e.metadata.placement) metadata.placement = e.metadata.placement;
  }
  if (e.metadata.sessionId) metadata.sessionId = e.metadata.sessionId;
  if (e.metadata.gitBranch && !cfg.hideBranchNames) metadata.gitBranch = e.metadata.gitBranch;
  return { ...usage, metadata };
}

function wireIdentity(repo: RepoIdentity): WireRepoIdentity {
  return { key: repo.key, label: repo.label, source: repo.source };
}

// "Hash only, still counted": the key becomes an HMAC under the install id,
// so the same repo still groups on this machine but is unnamed off it.
export function redactIdentity(repo: RepoIdentity, cfg: Config, installId: string): RepoIdentity {
  if (!cfg.hideRepoNames || repo.source === "folder") return repo;
  const digest = createHmac("sha256", installId).update(repo.key).digest("hex").slice(0, 16);
  return { key: `hidden:${digest}`, label: "", source: repo.source };
}
