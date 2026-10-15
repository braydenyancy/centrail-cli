import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { claudeConfigDirs, codexHomeDir } from "@centrail/parsers";
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
import {
  commandWords,
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
//   Codex        a user Stop hook in $CODEX_HOME/hooks.json running the
//                stable launcher (launcher.ts); Codex trusts it once by hash

export type Agent = "claude-code" | "codex";
export const AGENTS: readonly Agent[] = ["claude-code", "codex"];
const LABEL: Record<Agent, string> = { "claude-code": "Claude Code", codex: "Codex" };

export function parseAgents(names: string[]): Agent[] | undefined {
  if (names.length === 0) return undefined;
  const out: Agent[] = [];
  for (const name of names.flatMap((n) => n.split(",")).map((n) => n.trim()).filter(Boolean)) {
    if (!AGENTS.includes(name as Agent)) throw new Error(`Unknown agent "${name}": use ${AGENTS.join(" or ")}.`);
    if (!out.includes(name as Agent)) out.push(name as Agent);
  }
  return out;
}

export type IntegrationDeps = {
  env?: NodeJS.ProcessEnv; // PATH for detection
  platform?: NodeJS.Platform;
  claudeDir?: string; // default: the first Claude config dir (CLAUDE_CONFIG_DIR)
  codexHome?: string; // default: CODEX_HOME or ~/.codex
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
  codexHome: string;
  claudeSettings: string;
  codexHooks: string;
  launcher: string;
  recordedNode: string;
  script: string;
  node: string;
  deps: IntegrationDeps;
};

function context(deps: IntegrationDeps): Ctx {
  const platform = deps.platform ?? process.platform;
  const claudeDir = deps.claudeDir ?? claudeConfigDirs()[0];
  const codexHome = deps.codexHome ?? codexHomeDir();
  return {
    env: deps.env ?? process.env,
    platform,
    claudeDir,
    codexHome,
    claudeSettings: join(claudeDir, "settings.json"),
    codexHooks: join(codexHome, "hooks.json"),
    launcher: launcherPath(deps.configDir ?? CONFIG_DIR, platform),
    recordedNode: join(deps.configDir ?? CONFIG_DIR, "node"),
    script: deps.script ?? process.argv[1] ?? "",
    node: deps.node ?? process.execPath,
    deps,
  };
}

export type HookFinding = {
  form: "launcher" | "pinned" | "other"; // launcher: today's; pinned: 0.7.4–0.8.x; other: older forms
  current: boolean; // exactly the command setup writes now
  resolves: boolean; // its executable (and bundle) exist
};

type FileState = { detected: boolean; cli: string | null; readable: boolean; settings: Settings; indent: string; hooks: HookFinding[] };
export type ClaudeState = FileState & { plugin: { enabled: boolean; autoUpdate: boolean; release: boolean; version: string | null } };
export type CodexState = FileState;
export type LauncherState = { path: string; present: boolean; executable: boolean; current: boolean; script: string | null; resolvesCli: boolean };
// `expectedResolves`: whether the launcher setup would write finds a centrail to run.
export type Inspection = { claude: ClaudeState; codex: CodexState; launcher: LauncherState; expected: string; expectedResolves: boolean };

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
  const codexCli = await findExecutable("codex", ctx.env, ctx.platform);
  const claudeFile = await readHooksFile(ctx, ctx.claudeSettings, "claude-code");
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
  const codex: CodexState = {
    ...(await readHooksFile(ctx, ctx.codexHooks, "codex")),
    detected: codexCli !== null || (await isDir(ctx.codexHome)),
    cli: codexCli,
  };
  return { claude, codex, launcher, expected, expectedResolves };
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

async function readHooksFile(ctx: Ctx, path: string, agent: Agent): Promise<Omit<FileState, "detected" | "cli">> {
  let file: { settings: Settings; indent: string };
  try {
    file = await readSettingsFile(path);
  } catch {
    return { readable: false, settings: {}, indent: "  ", hooks: [] };
  }
  const expected = launcherCommand(ctx.launcher, agent, ctx.platform);
  const hooks: HookFinding[] = [];
  for (const command of stopCommands(file.settings).filter(isCentrailCommand)) {
    const words = commandWords(command) ?? [];
    const launcherForm = /(?:^|[\\/])centrail-hook(?:\.cmd)?$/.test(words[0] ?? "");
    const absolute = words.slice(0, 2).filter((w) => isAbsolute(w) || win32.isAbsolute(w));
    const pinned = !launcherForm && absolute.length === 2;
    const resolves = launcherForm
      ? await isExecutable(words[0], ctx.platform)
      : pinned && (await Promise.all(absolute.map(exists))).every(Boolean);
    hooks.push({ form: launcherForm ? "launcher" : pinned ? "pinned" : "other", current: command === expected, resolves });
  }
  return { readable: true, ...file, hooks };
}

function stopCommands(settings: Settings): string[] {
  const groups = Array.isArray(settings.hooks?.Stop) ? (settings.hooks.Stop as unknown[]) : [];
  const out: string[] = [];
  for (const g of groups) {
    if (!isObject(g) || !Array.isArray(g.hooks)) continue;
    for (const h of g.hooks) if (isObject(h) && h.type === "command" && typeof h.command === "string") out.push(h.command);
  }
  return out;
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
    const state = agent === "claude-code" ? ins.claude : ins.codex;
    const skip = (detail: string): PlanItem => ({ agent, action: "skip", via: null, detail });
    if (agents && !agents.includes(agent)) return skip("not selected");
    if (!state.detected) return skip("not detected");
    if (!state.readable) return skip(`${agent === "codex" ? "hooks.json" : "settings.json"} does not parse; fix it, then rerun`);
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

function hookPlan(agent: Agent, hooks: HookFinding[], launcher: LauncherState, why: string): PlanItem {
  const via = "hook" as const;
  if (hooks.length > 1) return { agent, action: "repair", via, detail: `${hooks.length} centrail Stop hooks → one, through the launcher` };
  if (hooks.length === 0) return { agent, action: "install", via, detail: `Stop hook through the launcher${why}` };
  if (!hooks[0].current) return { agent, action: "update", via, detail: `outdated ${hooks[0].form === "pinned" ? "pinned command" : "hook"} → the launcher` };
  if (!launcher.current) return { agent, action: "update", via, detail: "refresh the launcher" };
  return { agent, action: "ok", via, detail: "Stop hook through the launcher" };
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
    console.log("No supported agent found here (Claude Code, Codex). Install one, then run `centrail setup`.");
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
    else await applyHook(ctx, ctx.codexHooks, "codex");
  }
  if (plan.some((i) => i.agent === "codex" && pending(i))) {
    console.log("  Codex: open /hooks in Codex once and trust centrail's Stop hook. Codex trusts a hook by its hash;");
    console.log("    this command stays the same across centrail releases, so later updates need no new trust. Restart open sessions.");
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
    await applyHook(ctx, ctx.claudeSettings, "claude-code");
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
  await applyHook(ctx, ctx.claudeSettings, "claude-code");
}

async function applyHook(ctx: Ctx, path: string, agent: Agent): Promise<void> {
  const { settings, indent } = await readSettingsFile(path);
  await writeSettingsFile(path, installStopHook(settings, launcherCommand(ctx.launcher, agent, ctx.platform)), indent);
  console.log(`  ✓ ${LABEL[agent]}: Stop hook in ${path} runs the launcher.`);
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
  const files: [Agent, string, FileState][] = [
    ["claude-code", ctx.claudeSettings, ins.claude],
    ["codex", ctx.codexHooks, ins.codex],
  ];
  const hookFiles = files.filter(([a, , s]) => selected(a) && s.hooks.length > 0);
  const launcherKept = files.some(([a, , s]) => !selected(a) && s.hooks.some((h) => h.form === "launcher"));
  const removeLauncherFile = ins.launcher.present && !launcherKept;
  const lines = [
    ...(removePlugin ? [`  ${"Claude Code".padEnd(12)} remove   plugin ${PLUGIN_ID} and its marketplace`] : []),
    ...hookFiles.map(([a, , s]) => `  ${LABEL[a].padEnd(12)} remove   ${s.hooks.length} centrail Stop hook${s.hooks.length > 1 ? "s" : ""}`),
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
  for (const [agent, path] of hookFiles) {
    const { settings, indent } = await readSettingsFile(path);
    await writeSettingsFile(path, uninstallStopHook(settings), indent);
    console.log(`  ✓ ${LABEL[agent]}: removed centrail's Stop hook from ${path}.`);
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
