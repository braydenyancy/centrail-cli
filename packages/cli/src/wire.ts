import { createHmac } from "node:crypto";
import type { CommitFateRow, ParsedUsageEvent, Placement, RepoIdentity } from "@centrail/parsers";
import type { Config } from "./config.js";
import type { RecentCommit } from "./git.js";
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

// `known` is what the server advertised last time. A server that cannot be
// asked (down, flaky, a 5xx on this one route) reads as what it said last,
// never as "nothing extra": that downgrade would strip repo identity from
// events sent to a server that already keys on it.
export async function readCapabilities(auth: { baseUrl: string }, known?: Capabilities): Promise<Capabilities> {
  const fallback = known ?? { fields: new Set<string>() };
  try {
    const res = await fetch(`${auth.baseUrl}/api/cli/capabilities`, {
      headers: versionHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return fallback;
    const body = (await res.json()) as { fields?: unknown };
    const fields = Array.isArray(body.fields)
      ? body.fields.filter((f): f is string => typeof f === "string")
      : [];
    return { fields: new Set(fields) };
  } catch {
    return fallback;
  }
}

// The identity block an identity-aware server receives. Every field named.
export type WireRepoIdentity = {
  key: string;
  label: string;
  source: RepoIdentity["source"];
  root?: string; // root commit sha; withheld with the name under hideRepoNames
};

// Extends the 0.5.1 allowlist, and only for a server that lists "repo".
export type WireEventMetadata = {
  repo?: WireRepoIdentity;
  placement?: Placement; // how `repo` was chosen (§ 3.9); only ever next to it
  sessionId?: string;
  gitBranch?: string;
  origin: { machineId: string }; // the random install id; never the hostname
};

// Fast mode (`usage.speed`) and web-search requests: billed differently,
// carried for the server to price, only to a server that lists "usage-extras".
export type WireUsageExtras = { speed?: string; webSearchRequests?: number };

export type WireEvent = WireUsageEvent & WireUsageExtras & { metadata?: WireEventMetadata };

// The field policy, applied in one place so `centrail inspect --last` shows
// exactly what this function produced. Every field is named: nothing on the
// parsed event reaches the wire by being spread.
//   - every server: the 0.5.1 allowlist (toWireUsageEvent)
//   - a server that lists "repo": repo identity with its placement tag
//     (§ 3.9, the disclaimer next to it), session id, branch, and a random
//     per-install id
//   - a server that lists "usage-extras": speed and web-search requests
//   - never: working-directory paths, hostnames, platform, account data,
//     touched paths and turn ids (they exist to choose the repo)
//   - hideRepoNames / hideBranchNames: user toggles, applied here and, through
//     wireRepoRef / wireBranch, to every attribute body
export function toWireEvent(
  e: ParsedUsageEvent,
  caps: Capabilities,
  cfg: Config,
  installId: string,
): WireEvent {
  const wire: WireEvent = toWireUsageEvent(e);
  // Usage extras only to a server that stores them ("usage-extras").
  if (caps.fields.has("usage-extras")) {
    if (e.speed) wire.speed = e.speed;
    if (e.webSearchRequests) wire.webSearchRequests = e.webSearchRequests;
  }
  if (caps.fields.has("repo")) wire.metadata = identityMetadata(e, cfg, installId);
  return wire;
}

function identityMetadata(e: ParsedUsageEvent, cfg: Config, installId: string): WireEventMetadata {
  const metadata: WireEventMetadata = { origin: { machineId: installId } };
  if (e.metadata.repo) {
    metadata.repo = wireIdentity(redactIdentity(e.metadata.repo, cfg, installId));
    if (e.metadata.placement) metadata.placement = e.metadata.placement;
  }
  if (e.metadata.sessionId) metadata.sessionId = e.metadata.sessionId;
  const branch = wireBranch(e.metadata.gitBranch, cfg);
  if (branch) metadata.gitBranch = branch;
  return metadata;
}

function wireIdentity(repo: RepoIdentity): WireRepoIdentity {
  return { key: repo.key, label: repo.label, source: repo.source, ...(repo.root ? { root: repo.root } : {}) };
}

// "Hash only, still counted": the key becomes an HMAC under the install id,
// so the same repo still groups on this machine but is unnamed off it. The
// root sha goes too: it names a public repo as surely as its URL does. A
// folder's `dir:` key is already a keyed hash of its path; its label, the
// basename, would name it, so the label goes.
export function redactIdentity(repo: RepoIdentity, cfg: Config, installId: string): RepoIdentity {
  if (!cfg.hideRepoNames) return repo;
  if (repo.source === "folder") return { key: repo.key, label: "", source: repo.source };
  const digest = createHmac("sha256", installId).update(repo.key).digest("hex").slice(0, 16);
  return { key: `hidden:${digest}`, label: "", source: repo.source };
}

// A repo as the attribute route names it — `repos[]`, attributions, fate
// rows: the key its events carry, so the toggles mean the same on both
// routes and a server that matches joins the two. The name is the label,
// or under hideRepoNames the hidden key itself: the server rejects an
// empty name, and the folder's would name the repo.
export function wireRepoRef(repo: RepoIdentity, cfg: Config, installId: string): { name: string; key: string } {
  const shown = redactIdentity(repo, cfg, installId);
  return { name: shown.label || shown.key, key: shown.key };
}

// A branch as any route carries it: absent (null on a row) under
// hideBranchNames.
export function wireBranch(branch: string | null | undefined, cfg: Pick<Config, "hideBranchNames">): string | null {
  return branch && !cfg.hideBranchNames ? branch : null;
}

// Wire row for the optional `fates` section of POST /api/cli/attribute.
// The first four fields are the 0.5.1 row; the rest go only to a server
// that lists the field's capability. Every field named; no row is spread.
export type WireFate = {
  repoName: string;
  repoKey?: string;
  commitSha: string;
  branch: string | null;
  fate: "shipped" | "in_flight" | "unshipped";
  // "repo" — the commit's facts (§ 3.8): a server that advertises "match"
  // attributes this user's still-unattributed events of `repoKey` to these
  // commits.
  mergedAs?: string; // squashed into this default-branch commit (§ ship status)
  committedAt?: string;
  linesAdded?: number;
  linesDeleted?: number;
  filesChanged?: number;
  // The commit's author is this machine's git identity. Absent when either
  // side is unknown. The server prefers own commits when several fit; a
  // teammate's commit never absorbs this user's tokens by time alone.
  mine?: boolean;
  // "patch-id" — what proves a vanished sha equivalent to a live one
  // (§ 3.10, abandoned work): `git patch-id --stable` of the commit's own
  // diff against its first parent (absent for a merge or root commit), and
  // of the cumulative diff from its merge base with the default branch up
  // to it — what a squash of the branch up to this commit carries (absent
  // on the default branch). Content hashes: they reveal no code.
  patchId?: string;
  branchPatchId?: string;
};

// Everything the fate pass knows about one commit. Only what toWireFate
// names leaves; the author's address in `commit` never does.
export type LocalFate = {
  repoName: string;
  repoKey?: string;
  row: CommitFateRow;
  commit?: RecentCommit;
  mine?: boolean;
  patchId?: string;
  branchPatchId?: string;
};

// The fate-row policy, in the same one place as the event policy:
//   - every server: { repoName, commitSha, branch, fate } (0.5.1)
//   - "repo": repoKey, mergedAs, commit time, line/file counts, mine
//   - "patch-id": patchId, branchPatchId
//   - hideBranchNames: `branch` is null; `repoName` and `repoKey` arrive
//     as wireRepoRef shaped them
export function toWireFate(f: LocalFate, caps: Capabilities, cfg: Pick<Config, "hideBranchNames"> = { hideBranchNames: false }): WireFate {
  const repo = caps.fields.has("repo");
  const wire: WireFate = {
    repoName: f.repoName,
    ...(repo && f.repoKey ? { repoKey: f.repoKey } : {}),
    commitSha: f.row.sha,
    branch: wireBranch(f.row.branch, cfg),
    fate: f.row.fate,
  };
  if (repo) {
    if (f.row.mergedAs) wire.mergedAs = f.row.mergedAs;
    wire.committedAt = f.commit?.committedAt ?? "";
    wire.linesAdded = f.commit?.linesAdded ?? 0;
    wire.linesDeleted = f.commit?.linesDeleted ?? 0;
    wire.filesChanged = f.commit?.filesChanged ?? 0;
    if (f.mine !== undefined) wire.mine = f.mine;
  }
  if (caps.fields.has("patch-id")) {
    if (f.patchId) wire.patchId = f.patchId;
    if (f.branchPatchId) wire.branchPatchId = f.branchPatchId;
  }
  return wire;
}
