// Real-git tests for the fate pass's patch ids (abandoned work, § 3.10):
// a commit's `patchId` is its own diff's `git patch-id --stable`, and its
// `branchPatchId` that of the cumulative diff from its merge base with the
// default branch — what a squash of the branch up to that commit carries.
// The server moves a vanished sha's events only to a commit whose patch
// proves it equivalent, so these ids must equal what git itself computes
// for the copy, the squash and the prefix. Fixtures: ./testing/git-fixture.ts.
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { fixtureEnv, scratch, type Scratch } from "./testing/git-fixture.js";

const home = await mkdtemp(join(tmpdir(), "centrail-patchid-"));
process.env.CENTRAIL_CONFIG_DIR = join(home, "cfg");
const { gatherShipStatusFacts, runFatePass } = await import("./ship-status.js");

const run = promisify(execFile);
const HEX40 = /^[0-9a-f]{40}$/;

let fx: Scratch;
afterEach(async () => {
  vi.unstubAllGlobals();
  await fx?.cleanup();
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

// Every git call is dated a second after the last, near the wall clock: the
// fate pass only reads the last 90 days, and two commits with one parent,
// tree, message and date would be one sha.
let clock = Date.now() - 60 * 60_000;
async function g(cwd: string, ...args: string[]): Promise<string> {
  const iso = new Date((clock += 1000)).toISOString();
  const { stdout } = await run("git", ["-C", cwd, ...args], {
    env: { ...fixtureEnv(fx.root), GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  });
  return stdout.trim();
}
async function commit(cwd: string, file: string, content = `${file}\n`): Promise<string> {
  await writeFile(join(cwd, file), content);
  await g(cwd, "add", file);
  await g(cwd, "commit", "-q", "-m", file);
  return g(cwd, "rev-parse", "HEAD");
}
// A repo whose root commit is inside the window.
async function repo(name: string): Promise<string> {
  const dir = await fx.repo(name, { empty: true });
  await g(dir, "config", "user.email", "t@example.com"); // the fixture's author: every commit is `mine`
  await commit(dir, "root.txt");
  return dir;
}
// The reference: git's own patch id of `git diff <from> <to>`, computed
// independently of the code under test.
function referenceId(cwd: string, from: string, to: string): string {
  const env = fixtureEnv(fx.root);
  const diff = execFileSync("git", ["-C", cwd, "diff", "--no-renames", from, to], { env });
  return execFileSync("git", ["-C", cwd, "patch-id", "--stable"], { env, input: diff }).toString().split(/\s+/)[0];
}
const gather = async (dir: string) => (await gatherShipStatusFacts(dir, new Date(), true))!;

describe("patchId against real repos", () => {
  it("equals the patch id of the commit's cherry-pick and of its rebased copy: same diff, new sha", async () => {
    fx = await scratch();
    const dir = await repo("copy");
    await g(dir, "checkout", "-q", "-b", "feat");
    const f1 = await commit(dir, "f1.txt");
    const f2 = await commit(dir, "f2.txt", "two\nlines\n");
    await g(dir, "branch", "feat-before-rebase");
    await g(dir, "checkout", "-q", "main");
    await commit(dir, "main-moves.txt");
    await g(dir, "checkout", "-q", "feat");
    await g(dir, "rebase", "-q", "main");
    const [f2Rebased, f1Rebased] = (await g(dir, "rev-list", "--max-count=2", "HEAD")).split("\n");
    await g(dir, "checkout", "-q", "main");
    await g(dir, "cherry-pick", f2);
    const pick = await g(dir, "rev-parse", "HEAD");
    expect(new Set([f1, f2, f1Rebased, f2Rebased, pick]).size).toBe(5);

    const { patchIds } = await gather(dir);
    expect(patchIds[f2]).toMatch(HEX40);
    expect(patchIds[pick]).toBe(patchIds[f2]);
    expect(patchIds[f2Rebased]).toBe(patchIds[f2]);
    expect(patchIds[f1Rebased]).toBe(patchIds[f1]);
    expect(patchIds[f1]).not.toBe(patchIds[f2]);
    expect(patchIds[f2]).toBe(referenceId(dir, `${f2}^`, f2));
  });
});

describe("branchPatchId against real repos", () => {
  it("a squash on main of the whole branch carries the tip's branchPatchId; a squash of the first 2 of 3 carries the 2nd's, and maps exactly those commits", async () => {
    fx = await scratch();
    const dir = await repo("squash");
    await g(dir, "checkout", "-q", "-b", "feat");
    const b1 = await commit(dir, "f1.txt");
    const b2 = await commit(dir, "f1.txt", "f1\nedited by b2\n"); // one file twice: the cumulative diff is not the commits' diffs side by side
    const b3 = await commit(dir, "f3.txt");
    await g(dir, "checkout", "-q", "main");
    await commit(dir, "unrelated.txt"); // main moves first
    await g(dir, "merge", "--squash", "-q", "feat");
    await g(dir, "commit", "-q", "-m", "feat (#1)");
    const squashAll = await g(dir, "rev-parse", "HEAD");
    await g(dir, "checkout", "-q", "-b", "feat2");
    const c1 = await commit(dir, "g1.txt");
    const c2 = await commit(dir, "g2.txt");
    const c3 = await commit(dir, "g1.txt", "g1\nedited by c3\n");
    await g(dir, "checkout", "-q", "main");
    await commit(dir, "unrelated-2.txt");
    await g(dir, "merge", "--squash", "-q", c2);
    await g(dir, "commit", "-q", "-m", "feat2, first two (#2)");
    const squashTwo = await g(dir, "rev-parse", "HEAD");

    const facts = await gather(dir);
    const { patchIds, branchPatchIds } = facts;
    expect(branchPatchIds[b3]).toMatch(HEX40);
    expect(patchIds[squashAll]).toBe(branchPatchIds[b3]);
    expect(patchIds[squashTwo]).toBe(branchPatchIds[c2]);
    expect(patchIds[squashTwo]).not.toBe(branchPatchIds[c3]);
    expect(branchPatchIds[b1]).toBe(patchIds[b1]); // the first commit's prefix is its own patch
    expect(branchPatchIds[b2]).not.toBe(patchIds[b2]);
    // On the default branch: no branch patch.
    expect(branchPatchIds[squashAll]).toBeUndefined();
    expect(branchPatchIds[squashTwo]).toBeUndefined();
    // Squash detection (mergedAs) rides the same ids: the whole of feat, and
    // feat2's 2-commit prefix; c3, after it, is not squashed.
    expect(facts.squashedInto).toEqual({ [b1]: squashAll, [b2]: squashAll, [b3]: squashAll, [c1]: squashTwo, [c2]: squashTwo });
  });

  it("a branch that renames a file still matches its squash: neither side detects renames (0.6's prefix diff did, and never matched)", async () => {
    fx = await scratch();
    const dir = await repo("rename");
    await commit(dir, "big.txt", Array.from({ length: 50 }, (_, i) => `${i}`).join("\n") + "\n");
    await g(dir, "checkout", "-q", "-b", "feat");
    await g(dir, "mv", "big.txt", "moved.txt");
    await g(dir, "commit", "-q", "-m", "rename");
    const r1 = await g(dir, "rev-parse", "HEAD");
    const r2 = await commit(dir, "f2.txt");
    await g(dir, "checkout", "-q", "main");
    await commit(dir, "unrelated.txt");
    await g(dir, "merge", "--squash", "-q", "feat");
    await g(dir, "commit", "-q", "-m", "feat (#4)");
    const squash = await g(dir, "rev-parse", "HEAD");
    const facts = await gather(dir);
    expect(facts.squashedInto).toEqual({ [r1]: squash, [r2]: squash });
    expect(facts.patchIds[squash]).toBe(facts.branchPatchIds[r2]);
  });

  it("an unmerged branch maps nothing; commits after a squash stay unmapped", async () => {
    fx = await scratch();
    const dir = await repo("sq");
    await g(dir, "checkout", "-q", "-b", "feat");
    const b1 = await commit(dir, "f1");
    const b2 = await commit(dir, "f2");
    await g(dir, "checkout", "-q", "main");
    await g(dir, "merge", "--squash", "-q", "feat");
    await g(dir, "commit", "-q", "-m", "feat squashed");
    const squash = await g(dir, "rev-parse", "HEAD");
    await commit(dir, "unrelated");
    await g(dir, "checkout", "-q", "feat");
    const b3 = await commit(dir, "f3");
    await g(dir, "checkout", "-q", "-b", "other", "main");
    const o1 = await commit(dir, "o1");
    const facts = await gather(dir);
    expect(facts.squashedInto).toEqual({ [b1]: squash, [b2]: squash });
    expect(facts.branchPatchIds[b3]).toMatch(HEX40);
    expect(facts.branchPatchIds[o1]).toBe(facts.patchIds[o1]);
  });

  it("a branch that merged the default branch in: each commit's prefix is taken from its own merge base, and the squash still maps every commit", async () => {
    // GitHub's "Update branch": f1, f2, then main merged in, then f3.
    fx = await scratch();
    const dir = await repo("update");
    const root = await g(dir, "rev-parse", "HEAD");
    await g(dir, "checkout", "-q", "-b", "feat");
    const f1 = await commit(dir, "f1.txt");
    const f2 = await commit(dir, "f2.txt");
    await g(dir, "checkout", "-q", "main");
    const m1 = await commit(dir, "m1.txt");
    await g(dir, "checkout", "-q", "feat");
    await g(dir, "merge", "-q", "--no-ff", "-m", "update branch", "main");
    const update = await g(dir, "rev-parse", "HEAD");
    const f3 = await commit(dir, "f3.txt");
    await g(dir, "checkout", "-q", "main");
    await commit(dir, "m2.txt");
    await g(dir, "merge", "--squash", "-q", "feat");
    await g(dir, "commit", "-q", "-m", "feat (#3)");
    const squash = await g(dir, "rev-parse", "HEAD");

    const { patchIds, branchPatchIds, squashedInto } = await gather(dir);
    expect(branchPatchIds[f3]).toBe(referenceId(dir, m1, f3));
    expect(branchPatchIds[update]).toBe(referenceId(dir, m1, update));
    expect(branchPatchIds[f1]).toBe(referenceId(dir, root, f1)); // not m1: f1 predates the update
    expect(branchPatchIds[f2]).toBe(referenceId(dir, root, f2));
    expect(patchIds[squash]).toBe(branchPatchIds[f3]);
    expect(squashedInto).toEqual({ [f1]: squash, [f2]: squash, [update]: squash, [f3]: squash });
    // The update is a merge: no patch of its own.
    expect(patchIds[update]).toBeUndefined();
  });
});

describe("merge and root commits", () => {
  it("a root commit and a merge commit carry no patchId; a merge on the default branch no branchPatchId either", async () => {
    fx = await scratch();
    const dir = await repo("merges");
    const root = await g(dir, "rev-parse", "HEAD");
    await g(dir, "checkout", "-q", "-b", "feat");
    const f1 = await commit(dir, "f1.txt");
    await g(dir, "checkout", "-q", "main");
    await commit(dir, "m1.txt");
    await g(dir, "merge", "-q", "--no-ff", "-m", "merge feat", "feat");
    const merge = await g(dir, "rev-parse", "HEAD");

    const { patchIds, branchPatchIds, shas } = await gather(dir);
    expect(shas.map((c) => c.sha)).toEqual(expect.arrayContaining([root, merge, f1]));
    expect(patchIds[root]).toBeUndefined();
    expect(patchIds[merge]).toBeUndefined();
    expect(patchIds[f1]).toMatch(HEX40);
    for (const sha of [root, merge, f1]) expect(branchPatchIds[sha]).toBeUndefined(); // all on main
  });
});

// Ids are compared across machines, so nothing local may change them. A
// `-diff` attribute (a global attributes file, the repo's own, the system's)
// turns a text diff into "Binary files differ", whose patch id is another.
describe("patch ids ignore the machine's attributes", () => {
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  afterEach(() => {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  });

  it.each([
    ["a global attributes file", "global"],
    ["the repo's own .gitattributes", "tree"],
  ])("%s marking *.js -diff changes neither id", async (_, where) => {
    fx = await scratch();
    const dir = await repo("attrs");
    const root = await g(dir, "rev-parse", "HEAD");
    await g(dir, "checkout", "-q", "-b", "feat");
    const c = await commit(dir, "app.js", "console.log(1)\n");
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    const reference = referenceId(dir, root, c); // git's own id, before any attribute
    const plain = await gather(dir);
    if (where === "global") {
      await writeFile(join(fx.root, "attributes"), "*.js -diff\n");
      // Forward slashes: a backslash in a git config value is an escape.
      await writeFile(join(fx.root, "gitconfig"), `[core]\n\tattributesFile = ${join(fx.root, "attributes").replace(/\\/g, "/")}\n`);
      process.env.GIT_CONFIG_GLOBAL = join(fx.root, "gitconfig");
    } else {
      await writeFile(join(dir, ".gitattributes"), "*.js -diff\n");
    }
    const marked = await gather(dir);
    expect(plain.patchIds[c]).toBe(reference);
    expect([marked.patchIds[c], marked.branchPatchIds[c]]).toEqual([plain.patchIds[c], plain.branchPatchIds[c]]);
  });
});

describe("patch ids on the wire, real git", () => {
  const AUTH = { baseUrl: "https://centrail.test", token: "t" };
  async function fatesFor(dir: string, fields: string[], machineId?: string) {
    const bodies: Array<{ fates: Array<Record<string, unknown>> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response("{}", { status: 200 });
    }));
    await runFatePass(AUTH, [{ root: dir, name: "wire", key: "github.com/acme/wire" }], [], machineId, { fields: new Set(fields) });
    vi.unstubAllGlobals();
    return Object.fromEntries(bodies.flatMap((b) => b.fates).map((f) => [f.commitSha as string, f]));
  }

  it("a server that does not list \"patch-id\" gets today's rows; one that does gets patchId where the commit has one and branchPatchId off the default branch", async () => {
    fx = await scratch();
    const dir = await repo("wire");
    const root = await g(dir, "rev-parse", "HEAD");
    await g(dir, "checkout", "-q", "-b", "feat");
    const f1 = await commit(dir, "f1.txt");
    const f2 = await commit(dir, "f2.txt");
    await g(dir, "checkout", "-q", "main");
    const m1 = await commit(dir, "m1.txt");

    const TODAY = ["repoName", "repoKey", "commitSha", "branch", "fate", "committedAt", "linesAdded", "linesDeleted", "filesChanged", "mine"];
    for (const f of Object.values(await fatesFor(dir, ["repo", "match"], "install-1"))) expect(Object.keys(f).sort()).toEqual([...TODAY].sort());
    for (const f of Object.values(await fatesFor(dir, []))) expect(Object.keys(f).sort()).toEqual(["branch", "commitSha", "fate", "repoName"]);

    const rows = await fatesFor(dir, ["repo", "match", "patch-id"], "install-1");
    expect(Object.keys(rows).sort()).toEqual([root, f1, f2, m1].sort());
    expect(rows[root].patchId).toBeUndefined();
    expect(rows[m1].patchId).toMatch(HEX40);
    expect(rows[m1].branchPatchId).toBeUndefined();
    expect(rows[f1]).toMatchObject({ fate: "in_flight", patchId: expect.stringMatching(HEX40), branchPatchId: rows[f1].patchId });
    expect(rows[f2].branchPatchId).toBe(referenceId(dir, root, f2));
    expect(Object.keys(rows[f2]).sort()).toEqual([...TODAY, "patchId", "branchPatchId"].sort());
  });
});
