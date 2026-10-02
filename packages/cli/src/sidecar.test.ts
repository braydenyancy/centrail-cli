import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it.each([
    ["a torn tail", '{"v":1,"ts":"2026-06-01T00:00:00Z","surface":"claude-code","sessionId":"torn","cw'],
    ["a foreign object", '{"hello":"world"}'],
    ["a future version", '{"v":2,"ts":"2026-06-01T00:00:00Z","surface":"claude-code","sessionId":"v2","cwd":"/x"}'],
    ["an empty session id", '{"v":1,"ts":"2026-06-01T00:00:00Z","surface":"claude-code","sessionId":"","cwd":"/x"}'],
    ["a JSON array", '[1,2,3]'],
    ["a bare string", '"just text"'],
    ["null", "null"],
  ])("%s is skipped by read and dropped by compaction, without touching good lines", async (_, junk) => {
    const path = join(await mkdtemp(join(tmpdir(), "centrail-sc-")), "s.jsonl");
    const good = { v: 1 as const, ts: "2026-06-01T00:00:00Z", surface: "claude-code", sessionId: "ok", cwd: "/x", repo: null, root: null, branch: null, head: null };
    await appendSidecar(good, path);
    await appendFile(path, `${junk}\n`);
    await appendSidecar({ ...good, sessionId: "ok2" }, path);
    expect([...(await readSidecar(path)).keys()]).toEqual(["ok", "ok2"]);
    await compactSidecar(path, new Date("2026-06-02T00:00:00Z").getTime());
    const lines = (await readFile(path, "utf-8")).split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(2); // the junk line is gone, both good lines survive
    expect(lines.map((l) => JSON.parse(l).sessionId)).toEqual(["ok", "ok2"]);
    expect([...(await readSidecar(path)).keys()]).toEqual(["ok", "ok2"]);
  });

  it("compaction is idempotent and keeps the LAST line per session even when older lines come later in the file", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "centrail-sc-")), "s.jsonl");
    const base = { v: 1 as const, surface: "claude-code", sessionId: "s", cwd: "/x", repo: null, root: null, head: null };
    await appendSidecar({ ...base, ts: "2026-06-01T00:00:00Z", branch: "first" }, path);
    await appendSidecar({ ...base, ts: "2026-06-01T01:00:00Z", branch: "second" }, path);
    await appendSidecar({ ...base, ts: "2026-06-01T00:30:00Z", branch: "late-arrival" }, path); // appended last, stamped earlier
    const now = new Date("2026-06-02T00:00:00Z").getTime();
    await compactSidecar(path, now);
    const once = await readFile(path, "utf-8");
    await compactSidecar(path, now);
    expect(await readFile(path, "utf-8")).toBe(once);
    expect(once.trim().split("\n")).toHaveLength(1);
    // File order is append order, which is the order the hook observed
    // the session; the last append is the freshest observation.
    expect((await readSidecar(path)).get("s")?.branch).toBe("late-arrival");
  });
});
