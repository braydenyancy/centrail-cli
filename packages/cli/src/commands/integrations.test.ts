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
import { AGENTS, inspectIntegrations, parseAgents, planSetup, runIntegrationSetup, runUninstall, type IntegrationDeps } from "./integrations.js";
import type { ClaudeRunner } from "./plugin-setup.js";

const win = process.platform === "win32";
const NPM_GLOBAL = win ? "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\centrail\\dist\\index.js" : "/usr/local/lib/node_modules/centrail/dist/index.js";
const NPX = win ? "C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\0a1b\\node_modules\\centrail\\dist\\index.js" : "/home/u/.npm/_npx/0a1b/node_modules/centrail/dist/index.js";
const RELEASE = { source: "github", repo: "braydenyancy/centrail-cli", ref: "release" };

type Machine = { root: string; claudeDir: string; codexHome: string; geminiHome: string; copilotHome: string; piDir: string; configDir: string; deps: IntegrationDeps; calls: string[][] };
type MachineOpts = {
  claudeBin?: boolean; claudeDir?: boolean; codexBin?: boolean; codexHome?: boolean;
  geminiBin?: boolean; geminiHome?: boolean; copilotBin?: boolean; copilotHome?: boolean; piBin?: boolean; piDir?: boolean;
  script?: string;
};
let said: string;
let roots: string[] = [];

async function machine(opts: MachineOpts = {}): Promise<Machine> {
  const root = await mkdtemp(join(tmpdir(), "centrail-machine-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  const m: Machine = {
    root,
    claudeDir: join(root, "claude"),
    codexHome: join(root, "codex"),
    geminiHome: join(root, "home", ".gemini"),
    copilotHome: join(root, "copilot"),
    piDir: join(root, "pi", "agent"),
    configDir: join(root, "centrail"),
    calls: [],
    deps: {},
  };
  for (const [dir, on] of [[m.claudeDir, opts.claudeDir], [m.codexHome, opts.codexHome], [m.geminiHome, opts.geminiHome], [m.copilotHome, opts.copilotHome], [m.piDir, opts.piDir]] as const) {
    if (on) await mkdir(dir, { recursive: true });
  }
  const bins = [["claude", opts.claudeBin], ["codex", opts.codexBin], ["gemini", opts.geminiBin], ["copilot", opts.copilotBin], ["pi", opts.piBin]] as const;
  for (const [name, on] of bins) {
    if (!on) continue;
    // Records its argv; on Windows a .cmd is what PATHEXT finds.
    const file = join(bin, win ? `${name}.cmd` : name);
    await writeFile(file, win ? `@echo %* > "${root}\\${name}.argv"\r\n` : `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/${name}.argv"\n`, { mode: 0o755 });
  }
  m.deps = {
    env: { PATH: bin, PATHEXT: ".CMD;.EXE" },
    claudeDir: m.claudeDir,
    codexHome: m.codexHome,
    geminiHome: m.geminiHome,
    copilotHome: m.copilotHome,
    piAgentDir: m.piDir,
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
  // claude-code, codex, gemini-cli, copilot-cli, pi
  it.each([
    ["nothing", {}, [false, false, false, false, false]],
    ["claude on PATH only", { claudeBin: true }, [true, false, false, false, false]],
    ["Claude config dir only (the desktop app)", { claudeDir: true }, [true, false, false, false, false]],
    ["codex on PATH only", { codexBin: true }, [false, true, false, false, false]],
    ["CODEX_HOME only", { codexHome: true }, [false, true, false, false, false]],
    ["gemini on PATH only", { geminiBin: true }, [false, false, true, false, false]],
    ["~/.gemini only", { geminiHome: true }, [false, false, true, false, false]],
    ["copilot on PATH only", { copilotBin: true }, [false, false, false, true, false]],
    ["COPILOT_HOME only", { copilotHome: true }, [false, false, false, true, false]],
    ["pi on PATH only", { piBin: true }, [false, false, false, false, true]],
    ["Pi's agent dir only", { piDir: true }, [false, false, false, false, true]],
    ["all five, every way", { claudeBin: true, claudeDir: true, codexBin: true, codexHome: true, geminiBin: true, geminiHome: true, copilotBin: true, copilotHome: true, piBin: true, piDir: true }, [true, true, true, true, true]],
  ])("%s", async (_, opts, detected) => {
    const m = await machine(opts);
    const { claudeBin } = opts as { claudeBin?: boolean };
    const ins = await inspectIntegrations({ ...m.deps, claude: undefined });
    expect(AGENTS.map((a) => ins.agents[a].detected)).toEqual(detected);
    expect(ins.claude.cli !== null).toBe(Boolean(claudeBin));
    const plan = planSetup(ins);
    expect(plan.map((p) => p.action)).toEqual(detected.map((d) => (d ? "install" : "skip")));
    // Claude Code gets its plugin when `claude` can install it, else a hook.
    if (detected[0]) expect(plan[0].via).toBe(claudeBin ? "plugin" : "hook");
  });

  it("--agent names only the supported agents", () => {
    expect(parseAgents(["codex"])).toEqual(["codex"]);
    expect(parseAgents(["claude-code,codex", "codex"])).toEqual(["claude-code", "codex"]);
    expect(parseAgents([])).toBeUndefined();
    expect(parseAgents(["gemini-cli,copilot-cli", "pi"])).toEqual(["gemini-cli", "copilot-cli", "pi"]);
    expect(() => parseAgents(["gemini"])).toThrow(/claude-code, codex, gemini-cli, copilot-cli or pi/);
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
    expect(again.plan.map((p) => p.action)).toEqual(["ok", "ok", "skip", "skip", "skip"]);
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
    expect(r.plan.map((p) => [p.agent, p.action])).toEqual([["claude-code", "skip"], ["codex", "install"], ["gemini-cli", "skip"], ["copilot-cli", "skip"], ["pi", "skip"]]);
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

// Gemini CLI, Copilot CLI and Pi, each through its own per-turn mechanism
// (agent-hooks.ts), over real files in scratch homes holding the user's own
// configuration, which must come through setup and uninstall untouched.
describe("Gemini CLI, Copilot CLI and Pi", () => {
  const geminiSettings = (m: Machine) => join(m.geminiHome, "settings.json");
  const copilotFile = (m: Machine) => join(m.copilotHome, "hooks", "centrail.json");
  const piFile = (m: Machine) => join(m.piDir, "extensions", "centrail.js");
  const userGemini = {
    theme: "Dracula",
    hooks: {
      BeforeTool: [{ matcher: "write_file", hooks: [{ name: "lint", type: "command", command: "lint.sh", timeout: 5000 }] }],
      AfterAgent: [{ hooks: [{ name: "notify", type: "command", command: "notify-send done" }] }],
    },
  };
  const userCopilot = { version: 1, hooks: { sessionEnd: [{ type: "command", bash: "say bye", timeoutSec: 5 }] } };
  const userPi = "export default function (pi) { pi.on(\"agent_end\", () => {}); }\n";

  async function userMachine(): Promise<Machine> {
    const m = await machine({ geminiHome: true, copilotHome: true, piDir: true });
    await writeFile(geminiSettings(m), JSON.stringify(userGemini, null, 2));
    await mkdir(join(m.copilotHome, "hooks"), { recursive: true });
    await writeFile(join(m.copilotHome, "hooks", "notify.json"), JSON.stringify(userCopilot));
    await mkdir(join(m.piDir, "extensions"), { recursive: true });
    await writeFile(join(m.piDir, "extensions", "mine.ts"), userPi);
    return m;
  }

  it("plans one line each, and --dry-run writes nothing", async () => {
    const m = await userMachine();
    await runIntegrationSetup({ dryRun: true }, m.deps);
    expect(said).toMatch(/Gemini CLI {3}install {2}AfterAgent hook through the launcher/);
    expect(said).toMatch(/Copilot CLI {2}install {2}agentStop hook through the launcher/);
    expect(said).toMatch(/Pi {11}install {2}extension through the launcher/);
    expect(await json(geminiSettings(m))).toEqual(userGemini);
    await expect(read(copilotFile(m))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(read(piFile(m))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes one owned entry each, keeps every user hook, and a second run changes nothing", async () => {
    const m = await userMachine();
    await runIntegrationSetup({ yes: true }, m.deps);
    // Both run hooks through PowerShell on Windows: its call operator leads.
    const command = (surface: string) => `${win ? "& " : ""}"${launcher(m)}" hook stop --centrail-hook --surface ${surface}`;

    const gemini = await json(geminiSettings(m));
    expect(gemini.theme).toBe("Dracula");
    expect(gemini.hooks.BeforeTool).toEqual(userGemini.hooks.BeforeTool);
    expect(gemini.hooks.AfterAgent).toEqual([
      ...userGemini.hooks.AfterAgent,
      { hooks: [{ name: "centrail", type: "command", command: command("gemini-cli"), timeout: 10000 }] },
    ]);

    expect(await json(copilotFile(m))).toEqual({ version: 1, hooks: { agentStop: [{ type: "command", [win ? "powershell" : "bash"]: command("copilot-cli"), timeoutSec: 10 }] } });
    expect(await json(join(m.copilotHome, "hooks", "notify.json"))).toEqual(userCopilot);

    const ext = await read(piFile(m));
    expect(ext).toContain("centrail-pi-extension");
    expect(ext).toContain(`const launcher = ${JSON.stringify(launcher(m))};`);
    expect(ext).toContain('"--centrail-hook", "--surface", "pi"');
    expect(await read(join(m.piDir, "extensions", "mine.ts"))).toBe(userPi);

    const files = await Promise.all([geminiSettings(m), copilotFile(m), piFile(m), launcher(m)].map(read));
    said = "";
    const again = await runIntegrationSetup({ yes: true }, m.deps);
    expect(again.changed).toBe(false);
    expect(again.plan.map((p) => p.action)).toEqual(["skip", "skip", "ok", "ok", "ok"]);
    expect(await Promise.all([geminiSettings(m), copilotFile(m), piFile(m), launcher(m)].map(read))).toEqual(files);
  });

  it("uninstall removes only what centrail wrote: the user's files come back as they were", async () => {
    const m = await userMachine();
    await runIntegrationSetup({ yes: true }, m.deps);
    await runUninstall({ yes: true }, m.deps);
    expect(said).toMatch(/Gemini CLI {3}remove {3}1 centrail AfterAgent hook/);
    expect(said).toMatch(/Pi {11}remove {3}centrail's extension/);
    expect(await json(geminiSettings(m))).toEqual(userGemini);
    await expect(read(copilotFile(m))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await json(join(m.copilotHome, "hooks", "notify.json"))).toEqual(userCopilot);
    await expect(read(piFile(m))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await read(join(m.piDir, "extensions", "mine.ts"))).toBe(userPi);
    await expect(read(launcher(m))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an entry a user added to centrail.json; removes the file only when it held centrail's alone", async () => {
    const m = await machine({ copilotHome: true });
    await runIntegrationSetup({ yes: true }, m.deps);
    const file = await json(copilotFile(m));
    const mine = { type: "command", bash: "echo mine" };
    file.hooks.agentStop.unshift(mine);
    await writeFile(copilotFile(m), JSON.stringify(file));
    await runIntegrationSetup({ yes: true }, m.deps); // a rerun keeps it too
    expect((await json(copilotFile(m))).hooks.agentStop).toEqual([mine, expect.objectContaining({ timeoutSec: 10 })]);
    await runUninstall({ yes: true }, m.deps);
    expect(await json(copilotFile(m))).toEqual({ version: 1, hooks: { agentStop: [mine] } });
  });

  it("replaces an outdated entry with today's: another launcher path, an old extension", async () => {
    const m = await machine({ geminiHome: true, piDir: true });
    const old = installStopHook({}, `"${join(m.root, "old", "bin", "centrail-hook")}" hook stop --centrail-hook --surface gemini-cli`, "AfterAgent", { name: "centrail", timeout: 10000 });
    await writeFile(geminiSettings(m), JSON.stringify(old));
    await mkdir(join(m.piDir, "extensions"), { recursive: true });
    await writeFile(piFile(m), `// centrail-pi-extension (an older release)\nconst launcher = ${JSON.stringify(launcher(m))};\n`);
    const plan = planSetup(await inspectIntegrations(m.deps));
    expect(plan.find((p) => p.agent === "gemini-cli")).toMatchObject({ action: "update", detail: "outdated AfterAgent hook → the launcher" });
    expect(plan.find((p) => p.agent === "pi")).toMatchObject({ action: "update", detail: "outdated extension → the launcher" });
    await runIntegrationSetup({ yes: true }, m.deps);
    const after = (await json(geminiSettings(m))).hooks.AfterAgent;
    expect(after).toHaveLength(1);
    expect(after[0].hooks[0].command).toContain(launcher(m));
    expect(await read(piFile(m))).toContain('"--surface", "pi"');
  });

  it("never writes over a file it cannot read or does not own", async () => {
    const m = await machine({ geminiHome: true, piDir: true });
    const jsonc = '{\n  // a comment Gemini CLI tolerates\n  "theme": "x"\n}\n';
    await writeFile(geminiSettings(m), jsonc);
    await mkdir(join(m.piDir, "extensions"), { recursive: true });
    const foreign = "export default function () {}\n";
    await writeFile(piFile(m), foreign);
    const r = await runIntegrationSetup({ yes: true }, m.deps);
    expect(r.plan.find((p) => p.agent === "gemini-cli")).toMatchObject({ action: "skip", detail: "settings.json does not parse; fix it, then rerun" });
    expect(r.plan.find((p) => p.agent === "pi")).toMatchObject({ action: "skip", detail: "extensions/centrail.js is not centrail's; move it, then rerun" });
    await runUninstall({ yes: true }, m.deps);
    expect(await read(geminiSettings(m))).toBe(jsonc);
    expect(await read(piFile(m))).toBe(foreign);
  });

  it("on Windows, writes PowerShell call forms that it recognises as its own on the next run", async () => {
    const m = await machine({ geminiHome: true, copilotHome: true });
    const deps = { ...m.deps, platform: "win32" as const };
    await runIntegrationSetup({ yes: true }, deps);
    const cmd = launcherPath(m.configDir, "win32");
    expect(cmd).toMatch(/centrail-hook\.cmd$/);
    const expected = (surface: string) => `& "${cmd}" hook stop --centrail-hook --surface ${surface}`;
    expect((await json(geminiSettings(m))).hooks.AfterAgent[0].hooks[0].command).toBe(expected("gemini-cli"));
    expect((await json(copilotFile(m))).hooks.agentStop).toEqual([{ type: "command", powershell: expected("copilot-cli"), timeoutSec: 10 }]);
    const again = await runIntegrationSetup({ yes: true }, deps);
    expect(again.plan.filter((p) => p.agent === "gemini-cli" || p.agent === "copilot-cli").map((p) => p.action)).toEqual(["ok", "ok"]);
    await runUninstall({ yes: true }, deps);
    expect((await json(geminiSettings(m))).hooks).toBeUndefined();
    await expect(read(copilotFile(m))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("--agent pi sets up Pi alone and keeps the launcher while Pi runs it", async () => {
    const m = await machine({ codexHome: true, piDir: true });
    const r = await runIntegrationSetup({ yes: true, agents: ["pi"] }, m.deps);
    expect(r.plan.map((p) => p.action)).toEqual(["skip", "skip", "skip", "skip", "install"]);
    await runIntegrationSetup({ yes: true }, m.deps);
    await runUninstall({ yes: true, agents: ["codex"] }, m.deps);
    expect(await read(piFile(m))).toContain("centrail-pi-extension");
    expect(await read(launcher(m))).toContain("centrail");
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
