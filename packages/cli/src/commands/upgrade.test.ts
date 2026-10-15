import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launcherPath } from "../launcher.js";
import type { UpdateChannel } from "../update.js";
import { runUpgrade, upgradeStep } from "./upgrade.js";

// No test runs a package manager: `run` is injected and records the command.
let root: string;
let ran: string[][];
const run = async (cmd: string[]) => (ran.push(cmd), 0);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "centrail-upgrade-"));
  ran = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const deps = (channel: UpdateChannel) => ({ channel, run, configDir: join(root, "centrail"), script: "/usr/local/lib/node_modules/centrail/dist/index.js", node: "/usr/bin/node", env: { PATH: "" } });

describe("centrail upgrade", () => {
  it.each([
    ["mise", ["mise", "upgrade", "npm:centrail"]],
    ["npm-global", ["npm", "i", "-g", "centrail@latest"]],
    ["npx", null],
    ["plugin", null],
    ["unknown", null],
  ] as const)("%s → %j", (channel, command) => {
    expect(upgradeStep(channel).command).toEqual(command);
  });

  it("runs the channel's updater with -y, then refreshes an existing launcher", async () => {
    const path = launcherPath(join(root, "centrail"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "stale");
    const r = await runUpgrade({ yes: true }, deps("npm-global"));
    expect(ran).toEqual([["npm", "i", "-g", "centrail@latest"]]);
    expect(r.refreshed).toBe(true);
    expect(await readFile(path, "utf-8")).toContain("centrail");
  });

  it("asks first in a terminal, and without one only says the command", async () => {
    await runUpgrade({ interactive: true }, { ...deps("mise"), ask: async () => "n" });
    await runUpgrade({ interactive: false }, deps("mise"));
    expect(ran).toEqual([]);
    await runUpgrade({ interactive: true }, { ...deps("mise"), ask: async () => "" });
    expect(ran).toEqual([["mise", "upgrade", "npm:centrail"]]);
  });

  it("never creates a launcher nobody set up, and runs nothing for npx or the plugin", async () => {
    for (const channel of ["npx", "plugin"] as const) {
      const r = await runUpgrade({ yes: true }, deps(channel));
      expect(r).toEqual({ ran: null, refreshed: false });
    }
    expect(ran).toEqual([]);
    await expect(readFile(launcherPath(join(root, "centrail")))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a failed updater stops there", async () => {
    await expect(runUpgrade({ yes: true }, { ...deps("mise"), run: async () => 1 })).rejects.toThrow(/exited with 1/);
  });
});
