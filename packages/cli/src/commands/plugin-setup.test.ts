import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Claude Code plugin offer, against a scratch settings.json and a fake
// `claude`: no test runs the real one or touches ~/.claude. The fake does
// what the real one was seen to do (Claude Code 2.1.293, in a scratch
// CLAUDE_CONFIG_DIR): `marketplace add` refuses a source its settings entry
// does not name, and rewrites that entry without the keys it does not set
// (autoUpdate); `install` adds `enabledPlugins` and keeps the rest.
const dir = vi.hoisted(() => {
  const d = `${process.env.TMPDIR ?? "/tmp"}/centrail-plugin-setup-test-${process.pid}-${Date.now()}`;
  process.env.CENTRAIL_CONFIG_DIR = d;
  return d;
});

import { readConfig } from "../config.js";
import { hookCommand, installStopHook } from "./hooks-install.js";
import { offerPlugin, PLUGIN_STEPS, type ClaudeRunner } from "./plugin-setup.js";

const RELEASE = { source: "github", repo: "braydenyancy/centrail-cli", ref: "release" };
let settingsPath: string;
let said: string;
let calls: string[][];

function fakeClaude(opts: { fail?: string } = {}): ClaudeRunner {
  return async (args) => {
    calls.push(args);
    if (opts.fail && args.includes(opts.fail)) return { code: 1, output: "Cloning…\n✘ Failed: network unreachable\n" };
    const s = JSON.parse(await readFile(settingsPath, "utf-8").catch(() => "{}"));
    if (args[1] === "marketplace") {
      const declared = s.extraKnownMarketplaces?.centrail?.source;
      if (declared && JSON.stringify(declared) !== JSON.stringify(RELEASE)) {
        return { code: 1, output: `✘ Failed to add marketplace: Cannot add marketplace "centrail": its source doesn't match its extraKnownMarketplaces entry` };
      }
      s.extraKnownMarketplaces = { ...s.extraKnownMarketplaces, centrail: { source: RELEASE } };
    } else {
      s.enabledPlugins = { ...s.enabledPlugins, "centrail@centrail": true };
    }
    await writeFile(settingsPath, `${JSON.stringify(s, null, 2)}\n`);
    return { code: 0, output: "✔ done\n" };
  };
}
const never = async (): Promise<string> => {
  throw new Error("asked without a terminal");
};

beforeEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  settingsPath = join(await mkdtemp(join(tmpdir(), "centrail-claude-")), "settings.json");
  calls = [];
  said = "";
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void (said += `${a.map(String).join(" ")}\n`));
});

afterEach(() => vi.restoreAllMocks());

const settings = async () => JSON.parse(await readFile(settingsPath, "utf-8"));

describe("offerPlugin, on yes", () => {
  const handHook = hookCommand("/usr/bin/node", "/usr/lib/node_modules/centrail/dist/index.js");
  const original = installStopHook(
    {
      model: "opus",
      extraKnownMarketplaces: { other: { source: { source: "github", repo: "acme/plugins" }, autoUpdate: false } },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "lint" }] }],
        Stop: [{ hooks: [{ type: "command", command: "node other-stop.mjs" }] }],
      },
    },
    handHook,
  );

  it("adds the marketplace at #release, installs the plugin, turns its updates on, and removes only the hand-written hook", async () => {
    const raw = `${JSON.stringify(original, null, 4)}\n`;
    await writeFile(settingsPath, raw);

    await offerPlugin({ interactive: true }, { settingsPath, claude: fakeClaude(), ask: async () => "" });

    expect(calls).toEqual([
      ["plugin", "marketplace", "add", "braydenyancy/centrail-cli#release", "--scope", "user"],
      ["plugin", "install", "centrail@centrail", "--scope", "user"],
    ]);
    const after = await settings();
    expect(after.extraKnownMarketplaces).toEqual({
      other: { source: { source: "github", repo: "acme/plugins" }, autoUpdate: false },
      centrail: { source: RELEASE, autoUpdate: true },
    });
    expect(after.enabledPlugins).toEqual({ "centrail@centrail": true });
    expect(after.model).toBe("opus");
    expect(after.hooks.PreToolUse).toEqual(original.hooks!.PreToolUse);
    expect(after.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "node other-stop.mjs" }] }]);
    expect(await readFile(`${settingsPath}.centrail-backup`, "utf-8")).toBe(raw); // as found, before `claude` touched it
    expect((await readConfig()).pluginAnswer).toBe("yes");
    expect(said).toContain("Removed the Stop hook `centrail install-hooks` wrote");
    expect(said).toContain("Claude Code sessions already open: run /reload-plugins in each, or restart them");
  });

  it("re-points a marketplace 0.6.1's README added at the default branch, which `claude` alone refuses to move", async () => {
    await writeFile(settingsPath, JSON.stringify({ extraKnownMarketplaces: { centrail: { source: { source: "github", repo: "braydenyancy/centrail-cli" } } } }));

    await offerPlugin({ interactive: true }, { settingsPath, claude: fakeClaude(), ask: async () => "yes" });

    expect((await settings()).extraKnownMarketplaces.centrail).toEqual({ source: RELEASE, autoUpdate: true });
  });

  it("a failed `claude` step writes no autoUpdate, keeps the hand-written hook, and prints the steps", async () => {
    await writeFile(settingsPath, JSON.stringify(original));

    await offerPlugin({ interactive: true }, { settingsPath, claude: fakeClaude({ fail: "install" }), ask: async () => "" });

    const after = await settings();
    expect(after.extraKnownMarketplaces.centrail.autoUpdate).toBeUndefined();
    expect(after.hooks.Stop).toEqual(original.hooks!.Stop);
    expect(said).toContain("failed: ✘ Failed: network unreachable");
    expect(said).toContain(PLUGIN_STEPS);
  });

  it("never writes over a settings.json that does not parse", async () => {
    await writeFile(settingsPath, '{ "model": "opus", }');

    await offerPlugin({ interactive: true }, { settingsPath, claude: fakeClaude(), ask: async () => "" });

    expect(calls).toEqual([]);
    expect(await readFile(settingsPath, "utf-8")).toBe('{ "model": "opus", }');
    expect(said).toContain(`Cannot parse ${settingsPath}`);
    expect(said).toContain("claude plugin marketplace add braydenyancy/centrail-cli#release");
  });
});

describe("offerPlugin, otherwise", () => {
  it("on no: prints the steps once, writes nothing, and is not asked again", async () => {
    await writeFile(settingsPath, '{"model":"opus"}');

    await offerPlugin({ interactive: true }, { settingsPath, claude: fakeClaude(), ask: async () => "n" });

    expect(calls).toEqual([]);
    expect(await readFile(settingsPath, "utf-8")).toBe('{"model":"opus"}');
    expect(said).toContain("claude plugin install centrail@centrail");
    expect((await readConfig()).pluginAnswer).toBe("no");

    said = "";
    await offerPlugin({ interactive: true }, { settingsPath, claude: fakeClaude(), ask: never });
    expect(said).toBe("");
    // `centrail setup-plugin` asks again.
    await offerPlugin({ interactive: true, again: true }, { settingsPath, claude: fakeClaude(), ask: async () => "y" });
    expect((await settings()).extraKnownMarketplaces.centrail.autoUpdate).toBe(true);
  });

  it("without `claude` on PATH: prints the steps, does not ask, and asks at a later connect", async () => {
    await offerPlugin({ interactive: true }, { settingsPath, claude: null, ask: never });

    expect(said).toContain("claude plugin marketplace add braydenyancy/centrail-cli#release");
    expect((await readConfig()).pluginAnswer).toBeNull();
  });

  it("without a terminal: never asks, never writes", async () => {
    await offerPlugin({ interactive: false }, { settingsPath, claude: fakeClaude(), ask: never });

    expect(calls).toEqual([]);
    await expect(readFile(settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(said).toContain(PLUGIN_STEPS);
    expect((await readConfig()).pluginAnswer).toBeNull();
  });
});
