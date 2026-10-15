// The fate pass's memo against real git: worktrees of one repository are
// gathered once and answer what gathering each would; an unchanged
// repository answers from the memo; any ref that moves, a new day, or a
// different patch-id setting gathers afresh. Fixtures: ./testing/git-fixture.ts.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { fixtureEnv, scratch, type Scratch } from "./testing/git-fixture.js";

const home = await mkdtemp(join(tmpdir(), "centrail-memo-"));
process.env.CENTRAIL_CONFIG_DIR = join(home, "cfg");
const { gatherShipStatusFactsForRoots } = await import("./ship-status.js");
const { loadFactsMemo } = await import("./fate-memo.js");
type FactsMemo = Awaited<ReturnType<typeof loadFactsMemo>>;

const run = promisify(execFile);
let fx: Scratch;
afterEach(async () => {
  await fx?.cleanup();
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

let clock = Date.now() - 60 * 60_000;
async function g(cwd: string, ...args: string[]): Promise<string> {
  const iso = new Date((clock += 1000)).toISOString();
  const { stdout } = await run("git", ["-C", cwd, ...args], { env: { ...fixtureEnv(fx.root), GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } });
  return stdout.trim();
}
async function commit(cwd: string, file: string): Promise<string> {
  await writeFile(join(cwd, file), `${file}\n`);
  await g(cwd, "add", file);
  await g(cwd, "commit", "-q", "-m", file);
  return g(cwd, "rev-parse", "HEAD");
}

// Counts what the memo answered and what had to be gathered.
function counting(memo: FactsMemo) {
  const n = { hits: 0, sets: 0 };
  const wrapped: FactsMemo = {
    get: (k, d, now) => {
      const f = memo.get(k, d, now);
      if (f) n.hits++;
      return f;
    },
    set: (k, d, now, f) => {
      n.sets++;
      memo.set(k, d, now, f);
    },
    save: () => memo.save(),
  };
  return { memo: wrapped, n };
}

// One repository, its main checkout and two linked worktrees on branches.
async function repoWithWorktrees(): Promise<{ main: string; a: string; b: string }> {
  fx = await scratch();
  const main = await fx.repo("repo", { empty: true });
  await commit(main, "root.txt");
  const a = await fx.worktree(main, "wt-a", "feature/a");
  await commit(a, "a.txt");
  const b = await fx.worktree(main, "wt-b", "feature/b");
  await commit(b, "b.txt");
  return { main, a, b };
}

const comparable = <T extends { now?: string } | null>(f: T) => (f ? { ...f, now: "-" } : f);

describe("fate facts memo", () => {
  it("gathers a repository once for all its worktrees, with the facts each would give", async () => {
    const { main, a, b } = await repoWithWorktrees();
    const without = await gatherShipStatusFactsForRoots([main, a, b], true);
    const { memo, n } = counting(await loadFactsMemo(join(home, "one.json")));

    const withMemo = await gatherShipStatusFactsForRoots([main, a, b], true, memo);

    expect(n).toEqual({ hits: 0, sets: 1 });
    expect(comparable(withMemo)).toEqual(comparable(without));
    expect(withMemo!.shas).toHaveLength(3);
  });

  it("answers an unchanged repository from the memo, across a save and a reload", async () => {
    const { main, a } = await repoWithWorktrees();
    const path = join(home, "reload.json");
    const first = await loadFactsMemo(path);
    const before = await gatherShipStatusFactsForRoots([main, a], true, first);
    await first.save();
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600); // commit shas and author emails

    const { memo, n } = counting(await loadFactsMemo(path));
    const again = await gatherShipStatusFactsForRoots([a, main], true, memo);

    expect(n).toEqual({ hits: 1, sets: 0 });
    expect(comparable(again)).toEqual(comparable(before));
  });

  it.each([
    ["a commit on a worktree's branch", async (r: { a: string }) => void (await commit(r.a, "more.txt"))],
    ["a new branch", async (r: { main: string }) => void (await g(r.main, "branch", "feature/c"))],
    ["a detached worktree HEAD moving", async (r: { main: string }) => {
      const wt = await fx.worktree(r.main, "wt-d");
      await commit(wt, "detached.txt");
    }],
  ])("gathers afresh after %s", async (_, change) => {
    const r = await repoWithWorktrees();
    const path = join(home, `moved-${Math.random()}.json`);
    const first = await loadFactsMemo(path);
    const before = await gatherShipStatusFactsForRoots([r.main, r.a], true, first);
    await first.save();

    await change(r);
    const { memo, n } = counting(await loadFactsMemo(path));
    const after = await gatherShipStatusFactsForRoots([r.main, r.a], true, memo);

    expect(n).toEqual({ hits: 0, sets: 1 });
    expect(comparable(after)).toEqual(comparable(await gatherShipStatusFactsForRoots([r.main, r.a], true)));
    expect(JSON.stringify(comparable(after))).not.toBe(JSON.stringify(comparable(before)));
  });

  it("an entry answers only on its UTC day and for its patch-id setting", async () => {
    const { main } = await repoWithWorktrees();
    const memo = await loadFactsMemo(join(home, "day.json"));
    await gatherShipStatusFactsForRoots([main], true, memo);
    const [entry] = Object.entries(JSON.parse(JSON.stringify(await saved(memo, join(home, "day.json")))).entries as Record<string, { digest: string }>);
    const [key, { digest }] = entry;
    expect(memo.get(key, digest, new Date())).toBeDefined();
    expect(memo.get(key, digest, new Date(Date.now() + 36 * 3600_000))).toBeUndefined();
    expect(memo.get(key.replace(/patch-id$/, ""), digest, new Date())).toBeUndefined();
    expect(memo.get(key, "other-digest", new Date())).toBeUndefined();
  });

  it("an unreadable memo file is ignored, never fatal", async () => {
    const { main } = await repoWithWorktrees();
    const path = join(home, "garbled.json");
    await writeFile(path, "{not json");
    const { memo, n } = counting(await loadFactsMemo(path));
    expect(await gatherShipStatusFactsForRoots([main], false, memo)).not.toBeNull();
    expect(n).toEqual({ hits: 0, sets: 1 });
  });
});

async function saved(memo: FactsMemo, path: string): Promise<unknown> {
  await memo.save();
  return JSON.parse(await readFile(path, "utf-8"));
}
