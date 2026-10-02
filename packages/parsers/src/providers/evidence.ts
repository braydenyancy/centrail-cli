import { isAbsolute, join } from "node:path";

// Placement evidence: which files a request wrote and which it read, per
// surface. Pure string work — no filesystem, no git — so the CLI can run
// it in the Stop hook (while the folders still exist) and again at sync
// (over the whole transcript) and get the same answer. The placer turns
// paths into one repo per turn; see docs/decisions/2026-09-system-audit.md
// § 3.9. A surface without an extractor degrades to cwd + sticky.
//
// Writes outrank reads. A Bash command's absolute paths are reads: the
// command may have written, but the text does not say which.

export type Evidence = { writes: string[]; reads: string[] };

export const NO_EVIDENCE: Evidence = Object.freeze({ writes: [], reads: [] }) as Evidence;

export function mergeEvidence(a: Evidence | undefined, b: Evidence | undefined): Evidence {
  if (!a) return b ?? { writes: [], reads: [] };
  if (!b) return a;
  return { writes: union(a.writes, b.writes), reads: union(a.reads, b.reads) };
}

function union(x: string[], y: string[]): string[] {
  return [...new Set([...x, ...y])];
}

// Claude Code: one `tool_use` content block. The file tools name their
// target outright; Glob/Grep scope to a directory; Bash carries paths in
// its command text. Prose (Agent prompts, WebFetch URLs) is never evidence,
// and neither is an unknown tool.
const CLAUDE_WRITE_TOOLS: Record<string, string> = {
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};
const CLAUDE_READ_TOOLS: Record<string, string> = {
  Read: "file_path",
  Glob: "path",
  Grep: "path",
};

export function claudeToolEvidence(block: { name: unknown; input: unknown }): Evidence {
  const name = typeof block.name === "string" ? block.name : "";
  const input = isObject(block.input) ? block.input : {};
  const writeField = CLAUDE_WRITE_TOOLS[name];
  if (writeField) return { writes: absolute(input[writeField]), reads: [] };
  const readField = CLAUDE_READ_TOOLS[name];
  if (readField) return { writes: [], reads: absolute(input[readField]) };
  if (name === "Bash") return { writes: [], reads: bashPaths(typeof input.command === "string" ? input.command : "") };
  return { writes: [], reads: [] };
}

// Absolute paths in a shell command: quoted or bare, after a separator or
// `=`, never inside a URL, and never under the virtual filesystems or the
// toolchain directories no repo lives in (each other path costs the hook
// at most one git spawn, so /tmp, /var, /opt, /srv stay: repos live
// there). Order of first appearance, deduplicated.
const SYSTEM_PREFIXES = ["/dev", "/proc", "/sys", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];
const BASH_PATH = /(?:^|[\s=:;|&(<>'"`])(?:'(\/[^']+)'|"(\/[^"]+)"|(\/[^\s'"`;|&<>()]+))/g;

export function bashPaths(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(BASH_PATH)) {
    const path = m[1] ?? m[2] ?? m[3];
    if (!path) continue;
    if (path.startsWith("//")) continue; // `https://h/p`: the match starts at the scheme's `//`
    if (SYSTEM_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) continue;
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

// Codex: one `function_call` response item. `shell` / `shell_command` carry
// a `workdir` and a command; `apply_patch` names its files in the patch
// header, relative to the turn's cwd unless absolute.
export function codexCallEvidence(name: unknown, argumentsJson: unknown, cwd: string): Evidence {
  if (typeof name !== "string" || typeof argumentsJson !== "string") return { writes: [], reads: [] };
  let args: unknown;
  try {
    args = JSON.parse(argumentsJson);
  } catch {
    return { writes: [], reads: [] };
  }
  if (!isObject(args)) return { writes: [], reads: [] };
  if (name === "shell" || name === "shell_command" || name === "exec_command" || name === "local_shell") {
    const reads: string[] = [];
    const workdir = args.workdir;
    if (typeof workdir === "string" && isAbsolute(workdir)) reads.push(workdir);
    const command = Array.isArray(args.command) ? args.command.filter((c): c is string => typeof c === "string").join(" ") : typeof args.command === "string" ? args.command : "";
    for (const p of bashPaths(command)) if (!reads.includes(p)) reads.push(p);
    return { writes: [], reads };
  }
  if (name === "apply_patch") {
    const patch = typeof args.input === "string" ? args.input : typeof args.patch === "string" ? args.patch : "";
    const writes: string[] = [];
    for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
      const rel = m[1].trim();
      const abs = isAbsolute(rel) ? rel : join(cwd, rel);
      if (!writes.includes(abs)) writes.push(abs);
    }
    return { writes, reads: [] };
  }
  return { writes: [], reads: [] };
}

function absolute(v: unknown): string[] {
  return typeof v === "string" && isAbsolute(v) ? [v] : [];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
