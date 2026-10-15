import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `centrail setup` / `uninstall` over a scratch machine: a Claude config
// dir, a CODEX_HOME, centrail's config dir and a PATH holding fake `claude`
// and `codex` executables, all under one temp dir. No test reads or writes
// the real ~/.claude, ~/.codex or ~/.config/centrail, and none runs a real
// agent: Claude Code's commands go to a fake that edits settings the way the
// real one was seen to (plugin-setup.test.ts).
const cfg = vi.hoisted(() => {
  const d = `${process.env.TMPDIR ?? "/tmp"}/centrail-integrations-test-${process.pid}-${Date.now()}`;
  process.env.CENTRAIL_CONFIG_DIR = d;
  return d;
});

import { parseConfig, writeConfig } from "../config.js";
import { launcherPath } from "../launcher.js";
import { hookCommand, installStopHook } from "./hooks-install.js";
import { inspectIntegrations, parseAgents, planSetup, runIntegrationSetup, runUninstall, type IntegrationDeps } from "./integrations.js";
import type { ClaudeRunner } from "./plugin-setup.js";

const win = process.platform === "win32";
const NPM_GLOBAL = win ? "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\centrail\\dist\\index.js" : "/usr/local/lib/node_modules/centrail/dist/index.js";
const NPX = win ? "C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\0a1b\\node_modules\\centrail\\dist\\index.js" : "/home/u/.npm/_npx/0a1b/node_modules/centrail/dist/index.js";
const RELEASE = { source: "github", repo: "braydenyancy/centrail-cli", ref: "release" };

type Machine = { root: string; claudeDir: string; codexHome: string; configDir: string; deps: IntegrationDeps; calls: string[][] };
let said: string;
let roots: string[] = [];

async function machine(opts: { claudeBin?: boolean; claudeDir?: boolean; codexBin?: boolean; codexHome?: boolean; script?: string } = {}): Promise<Machine> {
  const root = await mkdtemp(join(tmpdir(), "centrail-machine-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  const m: Machine = { root, claudeDir: join(root, "claude"), codexHome: join(root, "codex"), configDir: join(root, "centrail"), calls: [], deps: {} };
  if (opts.claudeDir) await mkdir(m.claudeDir);
  if (opts.codexHome) await mkdir(m.codexHome);
  for (const [name, on] of [["claude", opts.claudeBin], ["codex", opts.codexBin]] as const) {
    if (!on) continue;
    // Records its argv; on Windows a .cmd is what PATHEXT finds.
    const file = join(bin, win ? `${name}.cmd` : name);
    await writeFile(file, win ? `@echo %* > "${root}\\${name}.argv"\r\n` : `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/${name}.argv"\n`, { mode: 0o755 });
  }
  m.deps = {
    env: { PATH: bin, PATHEXT: ".CMD;.EXE" },
    claudeDir: m.claudeDir,
    codexHome: m.codexHome,
    configDir: m.configDir,
    script: opts.script ?? NPM_GLOBAL,
    node: win ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/bin/node",
    claude: opts.claudeBin ? fakeClaude(m) : null,
    ask: async () => {
      throw new Error("asked unexpectedly");
    },
  };
  return m;
}

// What `claude plugin …` was seen to do to settings.json (Claude Code 2.1.293).
function fakeClaude(m: Machine, opts: { fail?: string } = {}): ClaudeRunner {
  return async (args) => {
    m.calls.push(args);
    if (opts.fail && args.includes(opts.fail)) return { code: 1, output: "✘ Failed: network unreachable\n" };
    const path = join(m.claudeDir, "settings.json");
    const s = JSON.parse(await readFile(path, "utf-8").catch(() => "{}"));
    const verb = args.slice(1, args[1] === "marketplace" ? 3 : 2).join(" ");
    if (verb === "marketplace add") s.extraKnownMarketplaces = { ...s.extraKnownMarketplaces, centrail: { source: RELEASE } };
    else if (verb === "install") s.enabledPlugins = { ...s.enabledPlugins, "centrail@centrail": true };
    else if (verb === "uninstall") delete s.enabledPlugins?.["centrail@centrail"];
    else if (verb === "marketplace remove") delete s.extraKnownMarketplaces?.centrail;
    await mkdir(m.claudeDir, { recursive: true });
    await writeFile(path, `${JSON.stringify(s, null, 2)}\n`);
    return { code: 0, output: "✔ done\n" };
  };
}

const read = (path: string) => readFile(path, "utf-8");
const json = async (path: string) => JSON.parse(await read(path));
const codexHooks = (m: Machine) => join(m.codexHome, "hooks.json");
const claudeSettings = (m: Machine) => join(m.claudeDir, "settings.json");
const launcher = (m: Machine) => launcherPath(m.configDir);

beforeEach(async () => {
  await rm(cfg, { recursive: true, force: true });
  await writeConfig(parseConfig({ scopeDecidedAt: "2026-06-01T00:00:00Z" }));
  said = "";
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void (said += `${a.map(String).join(" ")}\n`));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of roots) await rm(r, { recursive: true, force: true });
  roots = [];
});

describe("detection", () => {
  it.each([
    ["nothing", {}, [false, false]],
    ["claude on PATH only", { claudeBin: true }, [true, false]],
    ["Claude config dir only (the desktop app)", { claudeDir: true }, [true, false]],
    ["codex on PATH only", { codexBin: true }, [false, true]],
    ["CODEX_HOME only", { codexHome: true }, [false, true]],
    ["both, every way", { claudeBin: true, claudeDir: true, codexBin: true, codexHome: true }, [true, true]],
  ])("%s", async (_, opts, [claude, codex]) => {
    const m = await machine(opts);
    const { claudeBin } = opts as { claudeBin?: boolean };
    const ins = await inspectIntegrations({ ...m.deps, claude: undefined });
    expect([ins.claude.detected, ins.codex.detected]).toEqual([claude, codex]);
    expect(ins.claude.cli !== null).toBe(Boolean(claudeBin));
    const plan = planSetup(ins);
    expect(plan.map((p) => p.action)).toEqual([claude ? "install" : "skip", codex ? "install" : "skip"]);
    // Claude Code gets its plugin when `claude` can install it, else a hook.
    if (claude) expect(plan[0].via).toBe(claudeBin ? "plugin" : "hook");
  });

  it("--agent names only the supported agents", () => {
    expect(parseAgents(["codex"])).toEqual(["codex"]);
    expect(parseAgents(["claude-code,codex", "codex"])).toEqual(["claude-code", "codex"]);
    expect(parseAgents([])).toBeUndefined();
    expect(() => parseAgents(["gemini"])).toThrow(/claude-code or codex/);
  });
});

describe("centrail setup", () => {
  it("prints one line per agent, and --dry-run writes nothing", async () => {
    const m = await machine({ claudeBin: true, codexHome: true });
    const r = await runIntegrationSetup({ dryRun: true }, m.deps);
    expect(r.changed).toBe(false);
    expect(said).toMatch(/Claude Code {2}install {2}plugin centrail@centrail from braydenyancy\/centrail-cli#release, auto-update on/);
    expect(said).toMatch(/Codex {8}install {2}Stop hook through the launcher/);
    expect(said).toMatch(/launcher {5}install {2}/);
    expect(said).toContain("Dry run: nothing changed.");
    expect(m.calls).toEqual([]);
    await expect(read(codexHooks(m))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(read(launcher(m))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sets up both agents once; a second run changes nothing", async () => {
    const m = await machine({ claudeBin: true, codexHome: true });
    const other = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "lint" }] }] } };
    await writeFile(codexHooks(m), JSON.stringify(other));
    await runIntegrationSetup({ yes: true }, m.deps);

    expect(m.calls).toEqual([
      ["plugin", "marketplace", "add", "braydenyancy/centrail-cli#release", "--scope", "user"],
      ["plugin", "install", "centrail@centrail", "--scope", "user"],
    ]);
    const claude = await json(claudeSettings(m));
    expect(claude.extraKnownMarketplaces.centrail).toEqual({ source: RELEASE, autoUpdate: true });
    expect(claude.hooks).toBeUndefined(); // the plugin runs the hook
    const codex = await json(codexHooks(m));
    expect(codex.hooks.PreToolUse).toEqual(other.hooks.PreToolUse);
    expect(codex.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: expect.stringContaining("centrail-hook"), timeout: 10 }] }]);
    expect(codex.hooks.Stop[0].hooks[0].command).toMatch(/hook stop --centrail-hook --surface codex$/);
    expect(said).toContain("open /hooks in Codex once and trust centrail's Stop hook");

    const files = await Promise.all([claudeSettings(m), codexHooks(m), launcher(m)].map(read));
    said = "";
    const again = await runIntegrationSetup({ yes: true }, m.deps);
    expect(again.changed).toBe(false);
    expect(again.plan.map((p) => p.action)).toEqual(["ok", "ok"]);
    expect(said).toContain("Everything is set up; nothing to change.");
    expect(m.calls).toHaveLength(2); // `claude` not run again
    expect(await Promise.all([claudeSettings(m), codexHooks(m), launcher(m)].map(read))).toEqual(files);
  });

  it("moves an old pinned Codex entry to the launcher, keeping other Stop handlers", async () => {
    const m = await machine({ codexHome: true });
    const keep = { type: "command", command: "other-stop" };
    const pinned = `${hookCommand(m.deps.node, NPM_GLOBAL)} --surface codex`;
    const old = installStopHook({ hooks: { Stop: [{ matcher: "*", hooks: [keep] }] } }, pinned);
    await writeFile(codexHooks(m), JSON.stringify(old));
    const plan = planSetup(await inspectIntegrations(m.deps));
    expect(plan[1]).toMatchObject({ action: "update", detail: "outdated pinned command → the launcher" });

    await runIntegrationSetup({ yes: true }, m.deps);

    const stop = (await json(codexHooks(m))).hooks.Stop;
    expect(stop).toHaveLength(2);
    expect(stop[0]).toEqual({ matcher: "*", hooks: [keep] });
    expect(stop[1].hooks).toHaveLength(1);
    expect(stop[1].hooks[0].command).not.toContain(m.deps.node!);
    expect(stop[1].hooks[0].command).toContain(launcher(m));
  });

  it("run through npx, never writes the npx cache into a hook or the launcher", async () => {
    const m = await machine({ codexHome: true, script: NPX });
    await runIntegrationSetup({ yes: true }, m.deps);
    const text = await read(launcher(m));
    // The npx cache directory, not the `:run_npx` label of the Windows launcher.
    const npxCache = /[\\/]_npx[\\/]/;
    expect(text).not.toMatch(npxCache);
    expect(await read(codexHooks(m))).not.toMatch(npxCache);
    expect(text).toContain("centrail@0");
  });

  it("a later run through npx keeps the stable install an earlier setup recorded", async () => {
    const m = await machine({ codexHome: true });
    const global = join(m.root, "lib", "node_modules", "centrail", "dist", "index.js");
    await mkdir(join(global, ".."), { recursive: true });
    await writeFile(global, "");
    await runIntegrationSetup({ yes: true }, { ...m.deps, script: global });
    const first = await read(launcher(m));
    expect(first).toContain(global);
    const npx = await runIntegrationSetup({ yes: true }, { ...m.deps, script: NPX });
    expect(npx.plan[1].action).toBe("ok");
    expect(await read(launcher(m))).toBe(first);
  });

  it("without `claude`, gives Claude Code a Stop hook through the launcher", async () => {
    const m = await machine({ claudeDir: true });
    await writeFile(claudeSettings(m), `${JSON.stringify({ model: "opus" }, null, "\t")}\n`);
    await runIntegrationSetup({ yes: true }, m.deps);
    const s = await json(claudeSettings(m));
    expect(s.model).toBe("opus");
    expect(s.hooks.Stop[0].hooks[0].command).toMatch(/centrail-hook(?:\.cmd)?" hook stop --centrail-hook$/);
    expect(await read(claudeSettings(m))).toContain('\t"model"'); // its own indentation
  });

  it("when the plugin cannot install, falls back to the launcher hook; the next run moves to the plugin", async () => {
    const m = await machine({ claudeBin: true });
    await runIntegrationSetup({ yes: true }, { ...m.deps, claude: fakeClaude(m, { fail: "install" }) });
    expect((await json(claudeSettings(m))).hooks.Stop).toHaveLength(1);
    expect(said).toContain("standalone Stop hook until the plugin installs");

    await runIntegrationSetup({ yes: true }, m.deps);
    const s = await json(claudeSettings(m));
    expect(s.enabledPlugins).toEqual({ "centrail@centrail": true });
    expect(s.hooks).toBeUndefined();
  });

  it("repairs an enabled plugin's settings without `claude`: auto-update on, standalone hooks gone", async () => {
    const m = await machine({ claudeDir: true });
    await writeFile(claudeSettings(m), JSON.stringify(installStopHook({ enabledPlugins: { "centrail@centrail": true } }, hookCommand("/n", "/c/centrail/dist/index.js"))));
    const plan = planSetup(await inspectIntegrations(m.deps));
    expect(plan[0]).toMatchObject({ action: "repair", via: "plugin" });
    await runIntegrationSetup({ yes: true }, m.deps);
    const s = await json(claudeSettings(m));
    expect(s.hooks).toBeUndefined();
    expect(s.extraKnownMarketplaces.centrail).toEqual({ source: RELEASE, autoUpdate: true });
  });

  it("asks once in a terminal; no answer, or no terminal without -y, changes nothing", async () => {
    const m = await machine({ codexHome: true });
    await runIntegrationSetup({ interactive: false }, m.deps);
    expect(said).toContain("Run `centrail setup -y` to apply without asking.");
    for (const reply of ["n", null]) {
      const ask = vi.fn(async () => reply);
      await runIntegrationSetup({ interactive: true }, { ...m.deps, ask });
      expect(ask).toHaveBeenCalledTimes(1);
    }
    await expect(read(codexHooks(m))).rejects.toMatchObject({ code: "ENOENT" });
    const ask = vi.fn(async () => "");
    await runIntegrationSetup({ interactive: true }, { ...m.deps, ask });
    expect((await json(codexHooks(m))).hooks.Stop).toHaveLength(1);
  });

  it("asks the scope question first when it was never answered", async () => {
    await writeConfig(parseConfig({}));
    const m = await machine({ codexHome: true });
    const scope = vi.fn(async () => {});
    await runIntegrationSetup({ yes: true }, { ...m.deps, scope });
    expect(scope).toHaveBeenCalledTimes(1);
  });

  it("--agent limits the plan to the named agent", async () => {
    const m = await machine({ claudeBin: true, codexHome: true });
    const r = await runIntegrationSetup({ yes: true, agents: ["codex"] }, m.deps);
    expect(r.plan.map((p) => [p.agent, p.action])).toEqual([["claude-code", "skip"], ["codex", "install"]]);
    expect(m.calls).toEqual([]);
  });

  it("warns when the launcher would find no centrail to run, and finds npx beside the recorded Node", async () => {
    const m = await machine({ codexHome: true, script: NPX });
    // A Node that does not exist: CI images have a real one, with npx beside it, at the default path.
    m.deps.node = join(m.root, "absent-node", win ? "node.exe" : "node");
    await runIntegrationSetup({ dryRun: true }, m.deps);
    expect(said).toContain("the launcher finds no centrail to run here");
    const nodeDir = join(m.root, "node-bin");
    await mkdir(nodeDir);
    await writeFile(join(nodeDir, win ? "npx.cmd" : "npx"), "", { mode: 0o755 });
    await mkdir(m.configDir, { recursive: true });
    await writeFile(join(m.configDir, "node"), `${join(nodeDir, win ? "node.exe" : "node")}\n`);
    said = "";
    await runIntegrationSetup({ dryRun: true }, m.deps);
    expect(said).not.toContain("finds no centrail");
  });

  it("says when no supported agent is installed", async () => {
    const m = await machine();
    await runIntegrationSetup({ yes: true }, m.deps);
    expect(said).toContain("No supported agent found here");
  });

  it.skipIf(win)("runs the `claude` it finds on PATH", async () => {
    const m = await machine({ claudeBin: true });
    await runIntegrationSetup({ yes: true }, { ...m.deps, claude: undefined });
    expect((await read(join(m.root, "claude.argv"))).trim().split("\n")).toEqual(["plugin", "install", "centrail@centrail", "--scope", "user"]);
  });
});

describe("centrail uninstall", () => {
  it("is setup's exact inverse: plugin, hooks and launcher go; everything else stays as it was", async () => {
    const m = await machine({ claudeBin: true, codexHome: true });
    const original = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "other-stop" }] }] } };
    await mkdir(m.claudeDir, { recursive: true });
    await writeFile(claudeSettings(m), JSON.stringify(original));
    await writeFile(codexHooks(m), JSON.stringify(original));
    await runIntegrationSetup({ yes: true }, m.deps);

    m.calls.length = 0;
    await runUninstall({ yes: true }, m.deps);

    expect(m.calls).toEqual([
      ["plugin", "uninstall", "centrail@centrail", "--scope", "user"],
      ["plugin", "marketplace", "remove", "centrail"],
    ]);
    const claude = await json(claudeSettings(m));
    expect({ model: claude.model, hooks: claude.hooks }).toEqual(original);
    expect(claude.extraKnownMarketplaces).toEqual({});
    expect(await json(codexHooks(m))).toEqual(original);
    await expect(read(launcher(m))).rejects.toMatchObject({ code: "ENOENT" });
    said = "";
    await runUninstall({ yes: true }, m.deps);
    expect(said).toContain("Nothing of centrail's is installed");
  });

  it("keeps the launcher while an agent it was not asked about still runs it", async () => {
    const m = await machine({ claudeDir: true, codexHome: true });
    await runIntegrationSetup({ yes: true }, m.deps);
    await runUninstall({ yes: true, agents: ["codex"] }, m.deps);
    expect((await json(codexHooks(m))).hooks).toBeUndefined();
    expect((await json(claudeSettings(m))).hooks.Stop).toHaveLength(1);
    expect(await read(launcher(m))).toContain("centrail");
  });

  it("asks first, defaulting to no; keepPlugin (uninstall-hooks) leaves the plugin", async () => {
    const m = await machine({ claudeBin: true, codexHome: true });
    await runIntegrationSetup({ yes: true }, m.deps);
    m.calls.length = 0;
    await runUninstall({ interactive: true }, { ...m.deps, ask: async () => "" });
    expect(m.calls).toEqual([]);
    expect((await json(codexHooks(m))).hooks.Stop).toHaveLength(1);
    await runUninstall({ yes: true, keepPlugin: true }, m.deps);
    expect(m.calls).toEqual([]);
    expect((await json(claudeSettings(m))).enabledPlugins).toEqual({ "centrail@centrail": true });
    expect((await json(codexHooks(m))).hooks).toBeUndefined();
  });
});

// The built CLI, as a user runs it: old command names still work for one
// release and say where they went. Scratch homes through the environment.
describe("deprecated command names", () => {
  const DIST = join(__dirname, "..", "..", "dist", "index.js");

  function cli(args: string[], env: NodeJS.ProcessEnv) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [DIST, ...args], { env: { ...process.env, ...env }, windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end();
    });
  }

  async function homes() {
    const root = await mkdtemp(join(tmpdir(), "centrail-alias-"));
    roots.push(root);
    const env = {
      HOME: join(root, "home"),
      USERPROFILE: join(root, "home"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CODEX_HOME: join(root, "codex"),
      CENTRAIL_CONFIG_DIR: join(root, "centrail"),
      PATH: join(root, "bin"),
    };
    await mkdir(env.CODEX_HOME, { recursive: true });
    await mkdir(env.CENTRAIL_CONFIG_DIR, { recursive: true });
    await writeFile(join(env.CENTRAIL_CONFIG_DIR, "config.json"), JSON.stringify({ scopeDecidedAt: "2026-06-01T00:00:00Z" }));
    return env;
  }

  it("install-hooks runs setup without asking; uninstall-hooks undoes it; both point at the new name", async () => {
    const env = await homes();
    const install = await cli(["install-hooks"], env);
    expect(install.stderr).toMatch(/^centrail install-hooks is deprecated .*use `centrail setup`/);
    expect(install.code).toBe(0);
    expect((await json(join(env.CODEX_HOME, "hooks.json"))).hooks.Stop[0].hooks[0].command).toContain("centrail-hook");
    const remove = await cli(["uninstall-hooks"], env);
    expect(remove.stderr).toMatch(/use `centrail uninstall`/);
    expect((await json(join(env.CODEX_HOME, "hooks.json"))).hooks).toBeUndefined();
  });

  it("doctor-hooks --json keeps its version-1 report; doctor --json is version 2", async () => {
    const env = await homes();
    const v1 = await cli(["doctor-hooks", "--json"], env);
    expect(v1.stderr).toMatch(/use `centrail doctor`/);
    expect(JSON.parse(v1.stdout)).toMatchObject({ version: 1, findings: [], possibleDuplicates: false });
    const v2 = await cli(["doctor", "--json"], env);
    expect(JSON.parse(v2.stdout)).toMatchObject({ version: 2, ok: false, agents: { codex: { status: "missing" } } });
    expect(v2.code).toBe(1);
  });

  it("setup-plugin is setup for Claude Code", async () => {
    const env = await homes();
    const r = await cli(["setup-plugin", "--dry-run"], env);
    expect(r.stderr).toMatch(/use `centrail setup --agent claude-code`/);
    expect(r.stdout).toMatch(/Codex {8}skip {5}not selected/);
  });
});
