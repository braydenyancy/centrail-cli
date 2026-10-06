// Evidence extractors: per surface, which files a request wrote and read.
// Written before the extractors, to fix what counts as evidence. A URL is
// not a path; a relative path is not evidence; a Bash command's absolute
// paths are reads (it may have written, but the command does not say).
import { describe, expect, it } from "vitest";
import { bashPaths, claudeToolEvidence, codexCallEvidence, mergeEvidence, type Evidence } from "../src/providers/evidence.js";

const none: Evidence = { writes: [], reads: [] };

describe("claudeToolEvidence", () => {
  it.each([
    ["Edit", { file_path: "/w/a/src/x.ts", old_string: "a", new_string: "b" }, { writes: ["/w/a/src/x.ts"], reads: [] }],
    ["Write", { file_path: "/w/a/README.md", content: "x" }, { writes: ["/w/a/README.md"], reads: [] }],
    ["MultiEdit", { file_path: "/w/a/y.ts", edits: [] }, { writes: ["/w/a/y.ts"], reads: [] }],
    ["NotebookEdit", { notebook_path: "/w/a/n.ipynb", new_source: "" }, { writes: ["/w/a/n.ipynb"], reads: [] }],
    ["Read", { file_path: "/w/b/z.ts" }, { writes: [], reads: ["/w/b/z.ts"] }],
    ["Glob", { pattern: "**/*.ts", path: "/w/b" }, { writes: [], reads: ["/w/b"] }],
    ["Grep", { pattern: "foo", path: "/w/b/src" }, { writes: [], reads: ["/w/b/src"] }],
    ["Grep without a path", { pattern: "foo" }, none],
    ["Bash", { command: "cd /w/c && git status" }, { writes: [], reads: ["/w/c"] }],
    ["Edit with a relative path", { file_path: "src/x.ts" }, none],
    ["Edit with no path", { old_string: "a" }, none],
    ["WebFetch", { url: "https://example.com/w/a" }, none],
    ["Agent", { prompt: "look at /w/a/src/x.ts" }, none], // prose is not evidence
    ["mcp__foo__bar", { path: "/w/a" }, none], // unknown tools carry no evidence
  ])("%s → %j", (name, input, expected) => {
    expect(claudeToolEvidence({ name, input })).toEqual(expected);
  });
});

describe("bashPaths", () => {
  it.each([
    ["cd /w/a && npm test", ["/w/a"]],
    ["cat /w/a/x.ts | grep foo", ["/w/a/x.ts"]],
    ['git -C "/w/a b/repo" log', ["/w/a b/repo"]],
    ["git -C '/w/a/repo' log", ["/w/a/repo"]],
    ["ls /w/a /w/b", ["/w/a", "/w/b"]],
    ["FOO=/w/a/.env node x.js", ["/w/a/.env"]],
    ["curl https://example.com/w/a/x", []],
    ["echo http://h/p", []],
    ["cat /dev/null; ls /tmp/x /proc/self", ["/tmp/x"]], // virtual filesystems are never a repo; /tmp can be
    ["ls /usr/local/bin /etc/hosts /library", ["/library"]], // toolchain dirs are not; a prefix is not a match
    ["python3 /usr/bin/foo /w/a/s.py", ["/w/a/s.py"]],
    ["cd ~/w/a", []], // not absolute
    ["echo a/b/c", []],
    ["cat /w/a/x.ts; cat /w/a/x.ts", ["/w/a/x.ts"]],
    ["sed -n 1,5p /w/a/x.ts > /w/a/out.txt 2>/dev/null", ["/w/a/x.ts", "/w/a/out.txt"]],
    ["ls /w/a/)", ["/w/a/"]],
  ])("%s → %j", (command, paths) => {
    expect(bashPaths(command)).toEqual(paths);
  });
});

describe("codexCallEvidence", () => {
  const cwd = "/w/a";
  it.each([
    ["shell with workdir", "shell", { command: ["bash", "-lc", "ls"], workdir: "/w/b" }, { writes: [], reads: ["/w/b"] }],
    ["shell without workdir", "shell", { command: ["bash", "-lc", "cat /w/c/x"] }, { writes: [], reads: ["/w/c/x"] }],
    ["shell_command", "shell_command", { command: "cat /w/c/x", workdir: "/w/b" }, { writes: [], reads: ["/w/b", "/w/c/x"] }],
    ["apply_patch relative to cwd", "apply_patch", { input: "*** Begin Patch\n*** Update File: src/x.ts\n@@\n-a\n+b\n*** Add File: docs/n.md\n+hi\n*** Delete File: old.txt\n*** End Patch" }, { writes: ["/w/a/src/x.ts", "/w/a/docs/n.md", "/w/a/old.txt"], reads: [] }],
    ["apply_patch absolute", "apply_patch", { input: "*** Begin Patch\n*** Update File: /w/b/y.ts\n*** End Patch" }, { writes: ["/w/b/y.ts"], reads: [] }],
    ["wait", "wait", { cell_id: "1" }, none],
    ["unparseable arguments", "shell", "not json", none],
  ])("%s", (_, name, args, expected) => {
    const argumentsJson = typeof args === "string" ? args : JSON.stringify(args);
    expect(codexCallEvidence(name, argumentsJson, cwd)).toEqual(expected);
  });
});

describe("mergeEvidence", () => {
  it("unions in order without duplicates", () => {
    expect(mergeEvidence({ writes: ["/a"], reads: ["/b"] }, { writes: ["/a", "/c"], reads: [] })).toEqual({ writes: ["/a", "/c"], reads: ["/b"] });
  });
});
