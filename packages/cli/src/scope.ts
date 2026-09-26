import type { ParsedUsageEvent, RepoIdentity } from "@centrail/parsers";
import type { Config } from "./config.js";

// Pure scope rules. One place decides whether an event leaves the machine,
// so `centrail repos` can show exactly what sync will do.

// A list entry matches a repo by identity key or by label (folder name).
export function listHas(list: string[], repo: RepoIdentity): boolean {
  return list.includes(repo.key) || (repo.label !== "" && list.includes(repo.label));
}

export type ScopeStatus = "synced" | "excluded" | "waiting";

// waiting: `allow` mode and not (yet) on the list. Events with no identity
// (a folder that vanished before any hook saw it) follow the mode: sent in
// `all`, held in `allow`.
export function repoStatus(repo: RepoIdentity | undefined, cfg: Config): ScopeStatus {
  if (repo && listHas(cfg.denyRepos, repo)) return "excluded";
  if (cfg.mode === "allow") return repo && listHas(cfg.allowRepos, repo) ? "synced" : "waiting";
  return "synced";
}

export function eventInScope(e: ParsedUsageEvent, cfg: Config): boolean {
  return repoStatus(e.metadata.repo, cfg) === "synced";
}

export function surfaceEnabled(cfg: Config, surface: string): boolean {
  return cfg.surfaces[surface] !== false;
}

// What the machine has touched, one row per identity key, for the preview
// and `centrail repos`.
export type RepoRow = {
  key: string;
  labels: string[];
  source: RepoIdentity["source"];
  sessions: number;
  events: number;
  lastAt: Date;
};

export function summarizeRepos(events: ParsedUsageEvent[]): RepoRow[] {
  const rows = new Map<string, RepoRow & { sessionIds: Set<string> }>();
  for (const e of events) {
    const repo = e.metadata.repo;
    if (!repo) continue;
    let row = rows.get(repo.key);
    if (!row) {
      row = { key: repo.key, labels: [], source: repo.source, sessions: 0, events: 0, lastAt: e.occurredAt, sessionIds: new Set() };
      rows.set(repo.key, row);
    }
    if (repo.label && !row.labels.includes(repo.label)) row.labels.push(repo.label);
    if (e.metadata.sessionId) row.sessionIds.add(e.metadata.sessionId);
    row.events++;
    if (e.occurredAt > row.lastAt) row.lastAt = e.occurredAt;
  }
  return [...rows.values()]
    .map(({ sessionIds, ...r }) => ({ ...r, sessions: sessionIds.size }))
    .sort((a, b) => b.events - a.events || a.key.localeCompare(b.key));
}

export function shortKey(key: string): string {
  return key.startsWith("sha:") ? `${key.slice(0, 12)}…` : key;
}

export function renderRepoRows(rows: RepoRow[], cfg: Config): string[] {
  const width = Math.min(48, Math.max(20, ...rows.map((r) => shortKey(r.key).length)));
  return rows.map((r, i) => {
    const status = repoStatus({ key: r.key, label: r.labels[0] ?? "", source: r.source }, cfg);
    const mark = status === "synced" ? "✓" : status === "excluded" ? "✗" : "…";
    const note = r.source === "root" ? "  (no remote)" : r.source === "folder" ? "  (not a repo)" : "";
    const label = r.labels.join(", ");
    return `${String(i + 1).padStart(3)}. ${mark} ${shortKey(r.key).padEnd(width)}  ${label.padEnd(24).slice(0, 24)}  ${String(r.sessions).padStart(5)} sessions${note}`;
  });
}

// Parse the answer to "which should not sync": "2,5 7" → indexes; "only 1,3"
// → allow mode with those. Empty or garbage → no change.
export function parseSelection(answer: string, count: number): { mode: "all" | "allow"; picks: number[] } | null {
  const trimmed = answer.trim().toLowerCase();
  if (!trimmed) return null;
  const only = trimmed.startsWith("only");
  const nums = (only ? trimmed.slice(4) : trimmed)
    .split(/[\s,]+/)
    .map((t) => Number.parseInt(t, 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= count);
  if (nums.length === 0) return null;
  return { mode: only ? "allow" : "all", picks: [...new Set(nums)].map((n) => n - 1) };
}
