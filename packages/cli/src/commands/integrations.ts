import { readFile, stat } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";
import { claudeConfigDirs } from "@centrail/parsers";
import { CONFIG_DIR, readConfig } from "../config.js";
import {
  isExecutable,
  launcherPath,
  launcherScript,
  launcherScriptPath,
  launcherTarget,
  launcherValue,
  readLauncher,
  removeLauncher,
  writeLauncher,
} from "../launcher.js";
import { compareVersions, validVersion } from "../update.js";
import { AGENT_HOOKS, classifyCommand, defaultHome, type AgentHook, type HookAgent, type HookFile, type HookFinding } from "./agent-hooks.js";
import {
  groupCommands,
  installStopHook,
  isCentrailCommand,
  launcherCommand,
  PLUGIN_ID,
  pluginEnabled,
  readSettingsFile,
  uninstallStopHook,
  writeSettingsFile,
  type Settings,
} from "./hooks-install.js";
import {
  askLine,
  findExecutable,
  isReleaseSource,
  MARKETPLACE,
  MARKETPLACE_REPO,
  marketplaceEntry,
  RELEASE_REF,
  RELEASE_SOURCE,
  runnerFor,
  setUpPlugin,
  withMarketplace,
  type ClaudeRunner,
} from "./plugin-setup.js";
import { runSetup as runScopeReview } from "./scope.js";

// `centrail setup` / `centrail uninstall`: the agent integrations, one plan
// for every supported harness (docs/integrations.md). Detect what is
// installed, print one line per harness, ask once, apply idempotently: a
// second run with nothing to change writes nothing.
//
//   Claude Code  its plugin, kept current by Claude Code (plugin-setup.ts);
//                an explicit Stop hook through the launcher only when the
//                plugin cannot be installed (no `claude`, or it failed)
//   Codex, Gemini CLI, Copilot CLI, Pi
//                one entry each in the agent's own per-turn mechanism,
//                running the stable launcher (launcher.ts) with fixed
//                arguments (agent-hooks.ts); Codex trusts it once by hash
//   Cursor, OpenCode
//                the same, but no log scanner reads their usage yet: the
//                entry records repo identity only, so setup shows them and
//                adds one only when named (`--agent cursor`); an entry
//                already there is kept current

export type { HookAgent, HookFinding } from "./agent-hooks.js";
export type Agent = "claude-code" | HookAgent;
export const AGENTS: readonly Agent[] = ["claude-code", ...AGENT_HOOKS.map((h) => h.agent)];
// Agents whose entry records repo identity only: no usage source to join it to yet.
export const IDENTITY_ONLY: readonly Agent[] = AGENT_HOOKS.filter((h) => !h.usage).map((h) => h.agent);
export const LABEL: Record<Agent, string> = Object.fromEntries([["claude-code", "Claude Code"], ...AGENT_HOOKS.map((h) => [h.agent, h.label])]) as Record<Agent, string>;
const hookFor = (agent: HookAgent): AgentHook => AGENT_HOOKS.find((h) => h.agent === agent)!;

export function parseAgents(names: string[]): Agent[] | undefined {
  if (names.length === 0) return undefined;
  const out: Agent[] = [];
  for (const name of names.flatMap((n) => n.split(",")).map((n) => n.trim()).filter(Boolean)) {
    if (!AGENTS.includes(name as Agent)) throw new Error(`Unknown agent "${name}": use ${AGENTS.slice(0, -1).join(", ")} or ${AGENTS.at(-1)}.`);
    if (!out.includes(name as Agent)) out.push(name as Agent);
  }
  return out;
}

export type IntegrationDeps = {
  env?: NodeJS.ProcessEnv; // PATH for detection
  platform?: NodeJS.Platform;
  claudeDir?: string; // default: the first Claude config dir (CLAUDE_CONFIG_DIR)
  codexHome?: string; // default: CODEX_HOME or ~/.codex
  geminiHome?: string; // the .gemini dir; default: $GEMINI_CLI_HOME/.gemini or ~/.gemini
  copilotHome?: string; // default: COPILOT_HOME or ~/.copilot
  piAgentDir?: string; // default: PI_CODING_AGENT_DIR or ~/.pi/agent
  cursorHome?: string; // default: ~/.cursor
  opencodeConfigDir?: string; // default: $XDG_CONFIG_HOME/opencode or ~/.config/opencode
  configDir?: string; // default: centrail's config dir
  claude?: ClaudeRunner | null; // null: no `claude`; undefined: look on PATH
  ask?: (prompt: string) => Promise<string | null>; // null: input ended
  script?: string; // the running entry point (process.argv[1])
  node?: string; // the running Node (process.execPath)
  scope?: () => Promise<void>; // the scope question, when unanswered
};

type Ctx = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  claudeDir: string;
  claudeSettings: string;
  homes: Record<HookAgent, string>;
  files: Record<HookAgent, string>;
  launcher: string;
  recordedNode: string;
  script: string;
  node: string;
  deps: IntegrationDeps;
};

function context(deps: IntegrationDeps): Ctx {
  const platform = deps.platform ?? process.platform;
  const claudeDir = deps.claudeDir ?? claudeConfigDirs()[0];
  const given: Record<HookAgent, string | undefined> = {
    codex: deps.codexHome,
    "gemini-cli": deps.geminiHome,
    "copilot-cli": deps.copilotHome,
    pi: deps.piAgentDir,
    cursor: deps.cursorHome,
    opencode: deps.opencodeConfigDir,
  };
  const homes = Object.fromEntries(AGENT_HOOKS.map((h) => [h.agent, given[h.agent] ?? defaultHome(h.agent)])) as Record<HookAgent, string>;
  const files = Object.fromEntries(AGENT_HOOKS.map((h) => [h.agent, h.file(homes[h.agent])])) as Record<HookAgent, string>;
  return {
    env: deps.env ?? process.env,
    platform,
    claudeDir,
    claudeSettings: join(claudeDir, "settings.json"),
    homes,
    files,
    launcher: launcherPath(deps.configDir ?? CONFIG_DIR, platform),
    recordedNode: join(deps.configDir ?? CONFIG_DIR, "node"),
    script: deps.script ?? process.argv[1] ?? "",
    node: deps.node ?? process.execPath,
    deps,
  };
}

export type AgentState = HookFile & { detected: boolean; cli: string | null };
export type ClaudeState = AgentState & { settings: Settings; indent: string; plugin: { enabled: boolean; autoUpdate: boolean; release: boolean; version: string | null } };
export type LauncherState = { path: string; present: boolean; executable: boolean; current: boolean; script: string | null; resolvesCli: boolean };
// `agents`: every agent's state, Claude Code's being `claude`.
// `expectedResolves`: whether the launcher setup would write finds a centrail to run.
export type Inspection = { claude: ClaudeState; agents: Record<Agent, AgentState>; launcher: LauncherState; expected: string; expectedResolves: boolean };

// Read-only: what is installed, for setup's plan, doctor and uninstall.
export async function inspectIntegrations(deps: IntegrationDeps = {}): Promise<Inspection> {
  const ctx = context(deps);
  const content = await readLauncher(ctx.launcher);
  const recorded = content ? launcherScriptPath(content) : null;
  const previous = recorded && (await exists(recorded)) ? recorded : null;
  const target = launcherTarget(ctx.script, ctx.node, previous, ctx.env);
  const expected = launcherScript(target, ctx.platform);
  const executable = content !== null && (await isExecutable(ctx.launcher, ctx.platform));
  const launcher: LauncherState = {
    path: ctx.launcher,
    present: content !== null,
    executable,
    current: content === expected && executable,
    script: recorded,
    resolvesCli: executable && (previous !== null || (await cliReachable(ctx, content ? launcherValue(content, "pinned") : null))),
  };
  const expectedResolves = target.script !== null || (await cliReachable(ctx, target.node));
  const claudeCli = ctx.deps.claude === undefined ? await findExecutable("claude", ctx.env, ctx.platform) : ctx.deps.claude ? "claude" : null;
  const claudeFile = await readClaudeSettings(ctx);
  const settings = claudeFile.settings;
  const entry = marketplaceEntry(settings);
  const claude: ClaudeState = {
    ...claudeFile,
    detected: claudeCli !== null || (await isDir(ctx.claudeDir)),
    cli: claudeCli,
    plugin: {
      enabled: pluginEnabled(settings),
      autoUpdate: entry?.autoUpdate === true,
      release: isReleaseSource(entry?.source),
      version: await installedPluginVersion(ctx.claudeDir),
    },
  };
  const agents: Partial<Record<Agent, AgentState>> = { "claude-code": claude };
  for (const hook of AGENT_HOOKS) {
    const cli = await findExecutable(hook.bin, ctx.env, ctx.platform);
    const file = await hook.read(ctx.files[hook.agent], ctx.launcher, ctx.platform);
    agents[hook.agent] = { ...file, detected: cli !== null || (await isDir(ctx.homes[hook.agent])), cli };
  }
  return { claude, agents: agents as Record<Agent, AgentState>, launcher, expected, expectedResolves };
}

// Without a stable install the launcher runs `centrail` or `npx` from PATH,
// or from beside a Node it finds (the recorded one, the one setup ran with).
// A static check: doctor never runs the launcher.
async function cliReachable(ctx: Ctx, pinnedNode: string | null): Promise<boolean> {
  const recorded = (await readFile(ctx.recordedNode, "utf-8").catch(() => "")).trim();
  const beside = [recorded, pinnedNode].filter((n): n is string => Boolean(n)).map((n) => (ctx.platform === "win32" ? win32.dirname(n) : dirname(n)));
  const path = [ctx.env.PATH ?? ctx.env.Path ?? "", ...beside].filter(Boolean).join(ctx.platform === "win32" ? ";" : ":");
  const env = { ...ctx.env, PATH: path };
  for (const name of ["centrail", "npx"]) if (await findExecutable(name, env, ctx.platform)) return true;
  return false;
}

// Claude Code's user settings: its plugin state and any standalone Stop hook.
async function readClaudeSettings(ctx: Ctx): Promise<Omit<ClaudeState, "detected" | "cli" | "plugin">> {
  let file: { settings: Settings; indent: string };
  try {
    file = await readSettingsFile(ctx.claudeSettings);
  } catch {
    return { readable: false, settings: {}, indent: "  ", hooks: [] };
  }
  const expected = launcherCommand(ctx.launcher, "claude-code", ctx.platform);
  const hooks = await Promise.all(groupCommands(file.settings).filter(isCentrailCommand).map((c) => classifyCommand(c, expected, ctx.platform)));
  return { readable: true, ...file, hooks };
}

// Claude Code's own record of installed plugins: `plugins/installed_plugins.json`
// in its config dir, `{ plugins: { "<id>": [{ scope, version, … }] } }` (an
// object instead of the array in its first format). The newest version wins.
export async function installedPluginVersion(claudeDir: string = claudeConfigDirs()[0]): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(join(claudeDir, "plugins", "installed_plugins.json"), "utf-8")) as { plugins?: Record<string, unknown> };
    const entry = raw?.plugins?.[PLUGIN_ID];
    const versions = (Array.isArray(entry) ? entry : [entry])
      .map((e) => (isObject(e) ? e.version : undefined))
      .filter(validVersion);
    return versions.sort(compareVersions).pop() ?? null;
  } catch {
    return null;
  }
}

export type Action = "install" | "update" | "repair" | "ok" | "skip";
export type PlanItem = { agent: Agent; action: Action; via: "plugin" | "hook" | null; detail: string };

export function planSetup(ins: Inspection, agents?: Agent[]): PlanItem[] {
  return AGENTS.map((agent): PlanItem => {
    const state = ins.agents[agent];
    const skip = (detail: string): PlanItem => ({ agent, action: "skip", via: null, detail });
    if (agents && !agents.includes(agent)) return skip("not selected");
    if (!state.detected) return skip("not detected");
    if (!state.readable) {
      if (agent !== "claude-code" && hookFor(agent).module) return skip(`${hookFor(agent).fileName.replaceAll("\\", "/")} is not centrail's; move it, then rerun`);
      return skip(`${agent === "claude-code" ? "settings.json" : hookFor(agent).fileName.replaceAll("\\", "/")} does not parse; fix it, then rerun`);
    }
    // Shown, not added: without a usage source the entry would collect repo
    // identity that nothing joins yet. Named, it is added; present, kept current.
    if (IDENTITY_ONLY.includes(agent) && state.hooks.length === 0 && !agents?.includes(agent)) {
      return skip(`${NOT_SUPPORTED}; \`--agent ${agent}\` adds a repo-identity-only ${HOW[agent]}`);
    }
    if (agent === "claude-code") {
      const { plugin, hooks } = ins.claude;
      if (plugin.enabled) {
        const fixes = [
          ...(plugin.autoUpdate && plugin.release ? [] : [`turn on auto-update from #${RELEASE_REF}`]),
          ...(hooks.length ? [`remove ${hooks.length} standalone hook${hooks.length > 1 ? "s" : ""}`] : []),
        ];
        const version = plugin.version ? ` ${plugin.version}` : "";
        return fixes.length
          ? { agent, action: "repair", via: "plugin", detail: `plugin${version}: ${fixes.join(", ")}` }
          : { agent, action: "ok", via: "plugin", detail: `plugin${version}, updated by Claude Code` };
      }
      if (ins.claude.cli) {
        const replaces = hooks.length ? "; replaces the standalone hook" : "";
        return { agent, action: "install", via: "plugin", detail: `plugin ${PLUGIN_ID} from ${MARKETPLACE_REPO}#${RELEASE_REF}, auto-update on${replaces}` };
      }
    }
    return hookPlan(agent, state.hooks, ins.launcher, agent === "claude-code" ? " (no `claude` command for the plugin)" : "");
  });
}

export const NOT_SUPPORTED = "usage collection not supported yet (no usage source)";

// What each agent's entry is called in a plan line.
export const HOW: Record<Agent, string> = Object.fromEntries([["claude-code", "Stop hook"], ...AGENT_HOOKS.map((h) => [h.agent, h.how])]) as Record<Agent, string>;

function hookPlan(agent: Agent, hooks: HookFinding[], launcher: LauncherState, why: string): PlanItem {
  const via = "hook" as const;
  const how = HOW[agent];
  if (hooks.length > 1) return { agent, action: "repair", via, detail: `${hooks.length} centrail ${how}s → one, through the launcher` };
  const only = IDENTITY_ONLY.includes(agent) ? ", repo identity only" : "";
  if (hooks.length === 0) return { agent, action: "install", via, detail: `${how} through the launcher${why}${only}` };
  if (!hooks[0].current) return { agent, action: "update", via, detail: `outdated ${hooks[0].form === "pinned" ? "pinned command" : how} → the launcher` };
  if (!launcher.current) return { agent, action: "update", via, detail: "refresh the launcher" };
  return { agent, action: "ok", via, detail: `${how} through the launcher${only}` };
}

const pending = (item: PlanItem) => item.action !== "ok" && item.action !== "skip";

function printPlan(items: PlanItem[], launcher: LauncherState, title: string): void {
  console.log(title);
  for (const i of items) console.log(`  ${LABEL[i.agent].padEnd(12)} ${i.action.padEnd(8)} ${i.detail}`);
  if (items.some((i) => i.via === "hook" && i.action !== "skip")) {
    const action = !launcher.present ? "install" : launcher.current ? "ok" : "update";
    console.log(`  ${"launcher".padEnd(12)} ${action.padEnd(8)} ${launcher.path}`);
  }
}

export type SetupOptions = { agents?: Agent[]; yes?: boolean; dryRun?: boolean; interactive?: boolean };

export async function runIntegrationSetup(opts: SetupOptions, deps: IntegrationDeps = {}): Promise<{ plan: PlanItem[]; changed: boolean }> {
  const ctx = context(deps);
  const ins = await inspectIntegrations(deps);
  const plan = planSetup(ins, opts.agents);
  if (!plan.some((i) => i.action !== "skip" || i.detail !== "not detected")) {
    console.log(`No supported agent found here (${AGENTS.map((a) => LABEL[a]).join(", ")}). Install one, then run \`centrail setup\`.`);
    return { plan, changed: false };
  }
  printPlan(plan, ins.launcher, "centrail setup:");
  const usesLauncher = plan.some((i) => i.via === "hook" && pending(i));
  if (plan.some((i) => i.via === "hook" && i.action !== "skip") && !ins.expectedResolves) {
    console.log("  Note: the launcher finds no centrail to run here (no stable install, `centrail` or `npx` on PATH).");
    console.log("    Install one for agents to use: `npm i -g centrail` (or `mise use -g npm:centrail`), then rerun `centrail setup`.");
  }
  if (!plan.some(pending)) {
    console.log("Everything is set up; nothing to change.");
    return { plan, changed: false };
  }
  if (opts.dryRun) {
    console.log("Dry run: nothing changed.");
    return { plan, changed: false };
  }
  if (!(await confirm(opts, deps, "Apply this? [Y/n] ", "centrail setup -y"))) return { plan, changed: false };
  if (!(await readConfig()).scopeDecidedAt) await (deps.scope ?? (() => runScopeReview({ interactive: opts.interactive === true })))();

  if (usesLauncher) await writeLauncher(ins.expected, ctx.launcher);
  for (const item of plan.filter(pending)) {
    if (item.agent === "claude-code") await applyClaude(ctx, ins, item);
    else await applyHook(ctx, item.agent);
  }
  if (plan.some((i) => i.agent === "codex" && pending(i))) {
    console.log("  Codex: open /hooks in Codex once and trust centrail's Stop hook. Codex trusts a hook by its hash;");
    console.log("    this command stays the same across centrail releases, so later updates need no new trust. Restart open sessions.");
  }
  const atStart = plan.filter((i) => ["gemini-cli", "copilot-cli", "pi", "opencode"].includes(i.agent) && pending(i)).map((i) => LABEL[i.agent]);
  if (atStart.length) console.log(`  ${listed(atStart)} read${atStart.length > 1 ? "" : "s"} hooks, extensions and plugins at start: restart open sessions.`);
  const identity = plan.filter((i) => IDENTITY_ONLY.includes(i.agent) && pending(i)).map((i) => LABEL[i.agent]);
  if (identity.length) {
    console.log(`  ${listed(identity)}: repo identity only. centrail cannot read ${identity.length > 1 ? "their" : "its"} usage yet, so these turns`);
    console.log("    show no tokens or cost until a usage source for them ships.");
  }
  console.log("Each turn now records session id, folder, repo identity, branch, head and the repos its files touched,");
  console.log("locally, and starts a background `centrail sync` at most every 10 minutes.");
  console.log("Nothing leaves this machine except what `centrail inspect --last` shows. Check any time: `centrail doctor`.");
  return { plan, changed: true };
}

async function applyClaude(ctx: Ctx, ins: Inspection, item: PlanItem): Promise<void> {
  const claude = claudeRunner(ctx, ins);
  if (item.via === "plugin" && claude) {
    if (await setUpPlugin(claude, ctx.claudeSettings)) return;
    console.log("  Recording Claude Code turns through a standalone Stop hook until the plugin installs; rerun `centrail setup` to switch.");
    await writeLauncher(ins.expected, ctx.launcher);
    await applyClaudeHook(ctx);
    return;
  }
  if (item.via === "plugin") {
    // Enabled, but no `claude` to run: the settings Claude Code reads.
    const { settings, indent } = await readSettingsFile(ctx.claudeSettings);
    const entry = marketplaceEntry(settings) ?? { source: RELEASE_SOURCE };
    const next = uninstallStopHook(withMarketplace(settings, { ...entry, source: RELEASE_SOURCE, autoUpdate: true }));
    await writeSettingsFile(ctx.claudeSettings, next, indent);
    console.log(`  ✓ Claude Code plugin: auto-update on from #${RELEASE_REF}; standalone centrail hooks removed.`);
    return;
  }
  await applyClaudeHook(ctx);
}

async function applyClaudeHook(ctx: Ctx): Promise<void> {
  const { settings, indent } = await readSettingsFile(ctx.claudeSettings);
  await writeSettingsFile(ctx.claudeSettings, installStopHook(settings, launcherCommand(ctx.launcher, "claude-code", ctx.platform)), indent);
  console.log(`  ✓ Claude Code: Stop hook in ${ctx.claudeSettings} runs the launcher.`);
}

async function applyHook(ctx: Ctx, agent: HookAgent): Promise<void> {
  const hook = hookFor(agent);
  await hook.install(ctx.files[agent], ctx.launcher, ctx.platform);
  console.log(`  ✓ ${hook.label}: ${hook.how} in ${ctx.files[agent]} runs the launcher.`);
}

function claudeRunner(ctx: Ctx, ins: Inspection): ClaudeRunner | null {
  if (ctx.deps.claude !== undefined) return ctx.deps.claude;
  return ins.claude.cli ? runnerFor(ins.claude.cli, ctx.platform) : null;
}

export type UninstallOptions = { agents?: Agent[]; yes?: boolean; interactive?: boolean; keepPlugin?: boolean };

// The exact inverse of setup, limited to what centrail owns: its plugin
// (through `claude`), its Stop entries, and the launcher once no entry of
// centrail's still runs it.
export async function runUninstall(opts: UninstallOptions, deps: IntegrationDeps = {}): Promise<{ changed: boolean }> {
  const ctx = context(deps);
  const ins = await inspectIntegrations(deps);
  const selected = (a: Agent) => !opts.agents || opts.agents.includes(a);
  const removePlugin = selected("claude-code") && !opts.keepPlugin && ins.claude.plugin.enabled;
  const hookFiles = AGENTS.filter((a) => selected(a) && ins.agents[a].hooks.length > 0);
  const launcherKept = AGENTS.some((a) => !selected(a) && ins.agents[a].hooks.some((h) => h.form === "launcher"));
  const removeLauncherFile = ins.launcher.present && !launcherKept;
  const lines = [
    ...(removePlugin ? [`  ${"Claude Code".padEnd(12)} remove   plugin ${PLUGIN_ID} and its marketplace`] : []),
    ...hookFiles.map((a) => {
      const n = ins.agents[a].hooks.length;
      return `  ${LABEL[a].padEnd(12)} remove   ${a !== "claude-code" && hookFor(a).module ? `centrail's ${HOW[a]}` : `${n} centrail ${HOW[a]}${n > 1 ? "s" : ""}`}`;
    }),
    ...(removeLauncherFile ? [`  ${"launcher".padEnd(12)} remove   ${ins.launcher.path}`] : []),
  ];
  if (lines.length === 0) {
    console.log("Nothing of centrail's is installed in these agents.");
    return { changed: false };
  }
  console.log("centrail uninstall:");
  for (const l of lines) console.log(l);
  if (!(await confirm(opts, deps, "Remove these? [y/N] ", "centrail uninstall -y", false))) return { changed: false };
  if (removePlugin) {
    const claude = claudeRunner(ctx, ins);
    if (!claude) {
      console.log(`  Claude Code: run \`/plugin uninstall ${PLUGIN_ID}\` in Claude Code (no \`claude\` command here).`);
    } else {
      for (const args of [["plugin", "uninstall", PLUGIN_ID, "--scope", "user"], ["plugin", "marketplace", "remove", MARKETPLACE]]) {
        const r = await claude(args);
        const why = r.output.trim().split("\n").filter(Boolean).pop() ?? `exit ${r.code}`;
        console.log(r.code === 0 ? `  ✓ claude ${args.slice(0, -1).join(" ")}` : `  ✗ \`claude ${args.join(" ")}\` failed: ${why}`);
      }
    }
  }
  for (const agent of hookFiles) {
    const path = agent === "claude-code" ? ctx.claudeSettings : ctx.files[agent];
    if (agent === "claude-code") {
      const { settings, indent } = await readSettingsFile(path);
      await writeSettingsFile(path, uninstallStopHook(settings), indent);
    } else await hookFor(agent).uninstall(path);
    console.log(`  ✓ ${LABEL[agent]}: removed centrail's ${HOW[agent]} from ${path}.`);
  }
  if (removeLauncherFile && (await removeLauncher(ins.launcher.path))) console.log("  ✓ Removed the launcher.");
  console.log("Restart or reload open agent sessions. Local usage logs and centrail's pairing are untouched (`centrail sync` still works).");
  return { changed: true };
}

// One question for the whole plan. Without a terminal it asks nothing and
// changes nothing unless -y said yes beforehand.
async function confirm(opts: { yes?: boolean; interactive?: boolean }, deps: IntegrationDeps, prompt: string, unattended: string, byDefault = true): Promise<boolean> {
  if (opts.yes) return true;
  if (!opts.interactive) {
    console.log(`Nothing changed: no terminal to confirm in. Run \`${unattended}\` to apply without asking.`);
    return false;
  }
  const reply = await (deps.ask ?? askLine)(`  ${prompt}`);
  const answer = reply?.trim().toLowerCase();
  const yes = answer === undefined ? false : answer === "" ? byDefault : answer.startsWith("y");
  if (!yes) console.log("Nothing changed.");
  return yes;
}

function listed(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
