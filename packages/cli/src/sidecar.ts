import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RepoIdentity } from "@centrail/parsers";
import { CONFIG_DIR } from "./config.js";

// The sidecar: one line per agent turn, written by the Stop hook while the
// session's folder still exists. It carries the one thing a later scan
// cannot recover — which repo a session belonged to — because worktrees are
// created and deleted faster than syncs run (70% of tokens on the reference
// machine sat in folders that were gone by sync time). Append-only JSONL,
// compacted to the last line per session under the sync lock.
//
// Nothing here is uploaded as-is: sync joins it to usage events by session
// id and ships only the identity. `cwd` stays in the file, on the machine.

export const SIDECAR_PATH = `${CONFIG_DIR}/sessions.jsonl`;

export type SidecarLine = {
  v: 1;
  ts: string; // ISO time the hook fired
  surface: string; // "claude-code" | "codex" | …
  sessionId: string;
  cwd: string;
  repo: RepoIdentity | null; // null: not a repo (folder identity is derived at sync)
  root: string | null; // repo toplevel, for a live re-resolve
  branch: string | null; // null when detached
  head: string | null;
  // § 3.9: how far into the session's transcript the hook has read, and
  // the identity of every repo root a touched path fell under — recorded
  // while those folders existed. Cumulative across the session's lines.
  offset?: number;
  roots?: Record<string, RepoIdentity>;
  // root → its main checkout, for roots that are linked worktrees: where a
  // dead worktree's branches still live. Never on the wire.
  mains?: Record<string, string>;
  // The session's transcript, so sync can scan a relocated config dir even
  // when the hook's environment (and so the sync it spawns) was scrubbed of
  // CLAUDE_CONFIG_DIR. Byte offsets into its subagent transcripts. Local only.
  transcript?: string;
  subOffsets?: Record<string, number>;
};

export async function appendSidecar(line: SidecarLine, path: string = SIDECAR_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // One JSON line per append: POSIX guarantees an O_APPEND write of this
  // size lands whole, so concurrent hooks from parallel sessions interleave
  // by line, never inside one.
  await appendFile(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

// Last line per session id. A torn or foreign line is skipped, never fatal.
export async function readSidecar(path: string = SIDECAR_PATH): Promise<Map<string, SidecarLine>> {
  const out = new Map<string, SidecarLine>();
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return out;
  }
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isSidecarLine(line)) continue;
    out.set(line.sessionId, line);
  }
  return out;
}

// Rewrite the file as its last line per session, atomically. Hooks do not
// take the sync lock (they must stay fast), so an append that lands between
// the read below and the rename goes to the old inode and is lost. The bound
// on that loss: one turn's line, and only for a session with no earlier line
// kept — its next turn appends again. Lines from the last hour are kept
// verbatim so a session's most recent branch/head is never collapsed away
// while it is still live.
export async function compactSidecar(path: string = SIDECAR_PATH, now = Date.now()): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return;
  }
  const keep = new Map<string, string>();
  const recent: string[] = [];
  const cutoff = now - 60 * 60 * 1000;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isSidecarLine(line)) continue;
    if (new Date(line.ts).getTime() >= cutoff) recent.push(raw);
    else keep.set(line.sessionId, raw);
  }
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, [...keep.values(), ...recent].map((l) => `${l}\n`).join(""), { mode: 0o600 });
  await rename(tmp, path);
}

function isSidecarLine(v: unknown): v is SidecarLine {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.v === 1 &&
    typeof o.ts === "string" &&
    typeof o.surface === "string" &&
    typeof o.sessionId === "string" &&
    o.sessionId.length > 0 &&
    typeof o.cwd === "string"
  );
}
