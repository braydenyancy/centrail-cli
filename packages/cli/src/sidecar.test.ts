import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendSidecar, compactSidecar, readSidecar, type SidecarLine } from "./sidecar.js";

function line(sessionId: string, ts: string, branch: string | null = "main"): SidecarLine {
  return {
    v: 1,
    ts,
    surface: "claude-code",
    sessionId,
    cwd: "/w/repo",
    repo: { key: "github.com/a/r", label: "repo", source: "remote" },
    root: "/w/repo",
    branch,
    head: null,
  };
}

describe("sidecar", () => {
  it("reads the last line per session and skips torn or foreign lines", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "centrail-sc-")), "s.jsonl");
    await appendSidecar(line("a", "2026-06-01T00:00:00Z", "one"), path);
    await appendSidecar(line("a", "2026-06-01T00:01:00Z", "two"), path);
    await appendSidecar(line("b", "2026-06-01T00:02:00Z"), path);
    await writeFile(path, `${await readFile(path, "utf-8")}{"v":1,"sess\n{"other":true}\n`);

    const map = await readSidecar(path);
    expect([...map.keys()].sort()).toEqual(["a", "b"]);
    expect(map.get("a")?.branch).toBe("two");
  });

  it("compacts to one line per old session and keeps the last hour verbatim", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "centrail-sc-")), "s.jsonl");
    const now = Date.parse("2026-06-02T12:00:00Z");
    await appendSidecar(line("old", "2026-06-01T00:00:00Z", "x"), path);
    await appendSidecar(line("old", "2026-06-01T00:05:00Z", "y"), path);
    await appendSidecar(line("fresh", "2026-06-02T11:30:00Z", "p"), path);
    await appendSidecar(line("fresh", "2026-06-02T11:45:00Z", "q"), path);

    await compactSidecar(path, now);

    const rows = (await readFile(path, "utf-8")).trim().split("\n");
    expect(rows).toHaveLength(3);
    expect((await readSidecar(path)).get("old")?.branch).toBe("y");
  });

  it("readSidecar of a missing file is empty, compact of a missing file is a no-op", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "centrail-sc-")), "none.jsonl");
    expect((await readSidecar(path)).size).toBe(0);
    await expect(compactSidecar(path)).resolves.toBeUndefined();
  });
});
