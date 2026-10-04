// Squash detection's two caps against real history: 50 branch prefixes and
// 200 default-branch candidates. The candidates are the default branch's
// OLDEST 200 commits since the branch began, a set that later commits never
// change; the newest 200 dropped a squash once 200 more commits landed after
// it, and its branch flipped back from shipped. Histories of hundreds of
// commits are written with one `git fast-import` each, dated inside the
// fate pass's 90-day window. Fixtures: ./testing/git-fixture.ts.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { fixtureEnv, scratch, type Scratch } from "./testing/git-fixture.js";

const home = await mkdtemp(join(tmpdir(), "centrail-squash-"));
process.env.CENTRAIL_CONFIG_DIR = join(home, "cfg");
const { gatherShipStatusFacts } = await import("./ship-status.js");

let fx: Scratch;
afterEach(async () => {
  await fx?.cleanup();
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

// One fast-import stream of commits, each adding its own file; returns the
// shas in order. `from` starts the ref there; otherwise a ref that exists
// continues from its tip, and later commits chain on it.
type Spec = { ref: string; files: string[]; from?: string };
let clock = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
async function write(repo: string, specs: Spec[]): Promise<string[]> {
  const existing = new Set((await fx.git(repo, "for-each-ref", "--format=%(refname)")).split("\n"));
  const started = new Set<string>();
  let stream = "";
  let mark = 0;
  for (const s of specs) {
    mark++;
    clock += 60;
    stream += `commit ${s.ref}\nmark :${mark}\ncommitter t <t@example.com> ${clock} +0000\ndata 1\nc\n`;
    const from = s.from ?? (!started.has(s.ref) && existing.has(s.ref) ? `${s.ref}^0` : undefined);
    started.add(s.ref);
    if (from) stream += `from ${from}\n`;
    for (const f of s.files) stream += `M 100644 inline ${f}\ndata ${f.length + 1}\n${f}\n`;
    stream += "\n";
  }
  const marks = join(repo, ".git", "marks");
  await new Promise<void>((resolve, reject) => {
    const child = execFile("git", ["-C", repo, "fast-import", "--quiet", `--export-marks=${marks}`], { env: fixtureEnv(fx.root) }, (err, _out, stderr) => (err ? reject(new Error(`${err.message}: ${stderr}`)) : resolve()));
    child.stdin!.end(stream);
  });
  const byMark = new Map((await readFile(marks, "utf-8")).trim().split("\n").map((l) => l.split(" ") as [string, string]));
  return specs.map((_, i) => byMark.get(`:${i + 1}`)!);
}
const sha = async (repo: string, ref: string) => fx.git(repo, "rev-parse", ref);
const range = (n: number, prefix: string): Spec[] => Array.from({ length: n }, (_, i) => ({ ref: "refs/heads/main", files: [`${prefix}${i}.txt`] }));

// main: a root; feat: `branch` commits off it; main: `before` commits, then
// the squash of feat's first `squashed` commits, then `after` commits; feat:
// `more` commits after the squash. Returns the squash and feat's commits.
async function history(o: { branch: number; squashed?: number; before?: number; after?: number; more?: number }) {
  fx = await scratch();
  const repo = join(fx.root, "r");
  await mkdir(repo);
  await fx.git(repo, "init", "-q", "--template=", "-b", "main");
  const [root] = await write(repo, [{ ref: "refs/heads/main", files: ["root.txt"] }]);
  const feat = await write(repo, Array.from({ length: o.branch }, (_, i) => ({ ref: "refs/heads/feat", files: [`f${i}.txt`], ...(i === 0 ? { from: root } : {}) })));
  await write(repo, range(o.before ?? 0, "before"));
  const squashedFiles = Array.from({ length: o.squashed ?? o.branch }, (_, i) => `f${i}.txt`);
  const [squash] = await write(repo, [{ ref: "refs/heads/main", files: squashedFiles }]);
  await write(repo, range(o.after ?? 0, "after"));
  const more = await write(repo, Array.from({ length: o.more ?? 0 }, (_, i) => ({ ref: "refs/heads/feat", files: [`g${i}.txt`] })));
  return { repo, squash, feat: [...feat, ...more] };
}
const squashedInto = async (repo: string) => (await gatherShipStatusFacts(repo))!.squashedInto ?? {};

describe("squash candidates: the oldest 200 since the branch began", () => {
  it("a squash followed by 250 commits on main still ships its branch (the newest 200 lost it)", async () => {
    const { repo, squash, feat } = await history({ branch: 2, after: 250 });
    expect(await squashedInto(repo)).toEqual({ [feat[0]]: squash, [feat[1]]: squash });
  });

  it.each([
    [199, true],
    [200, false],
  ])("%i commits on main between the branch's start and its squash: found %s (the cap is 200)", async (before, found) => {
    const { repo, squash, feat } = await history({ branch: 2, before });
    expect(await squashedInto(repo)).toEqual(found ? { [feat[0]]: squash, [feat[1]]: squash } : {});
  });
});

describe("squash prefixes: the newest 50 commits of the branch", () => {
  it("a 60-commit branch squashed whole maps every commit the cap reads", async () => {
    const { repo, squash, feat } = await history({ branch: 60 });
    const mapped = await squashedInto(repo);
    expect(Object.keys(mapped).sort()).toEqual(feat.slice(10).sort());
    expect(new Set(Object.values(mapped))).toEqual(new Set([squash]));
  });

  it.each([
    [49, true],
    [50, false],
  ])("its first commit squashed, then %i more on the branch: found %s (the cap is 50)", async (more, found) => {
    const { repo, squash, feat } = await history({ branch: 1, more });
    expect(await squashedInto(repo)).toEqual(found ? { [feat[0]]: squash } : {});
  });
});
