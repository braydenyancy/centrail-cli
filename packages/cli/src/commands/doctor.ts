import { readState } from "../config.js";
import { CLI_VERSION } from "../version.js";
import { copyLabel, detectChannel, here, isOlder, liveVersionRecords, outdatedLine, updateNoticeLine, type UpdateChannel } from "../update.js";
import { AGENTS, inspectIntegrations, planSetup, runIntegrationSetup, type Action, type Agent, type Inspection, type IntegrationDeps } from "./integrations.js";

// `centrail doctor`: read-only. Whether each detected agent runs centrail
// after every turn, through a hook entry and launcher that resolve, and
// whether the copies of centrail on this machine are current. Never runs a
// hook, never prints a command, path or config value (the report is safe to
// paste). Exits 1 when something needs action; `--fix` runs `setup -y` for
// the agents that do.

export type AgentStatus = "ok" | "not-detected" | "unreadable" | "missing" | "duplicate" | "outdated-pin" | "unresolved" | "repair";

export type AgentReport = {
  detected: boolean;
  integration: "plugin" | "hook" | "none";
  plugin: { enabled: boolean; autoUpdate: boolean; version: string | null } | null; // Claude Code only
  hooks: number; // centrail's Stop entries in the agent's user hook file
  usesLauncher: boolean | null; // null without a hook entry
  commandResolves: boolean | null; // null without a hook entry
  status: AgentStatus;
  fix: Action; // what `centrail setup` would do
};

// `--json`, version 2. `doctor-hooks --json` keeps printing version 1.
export type DoctorReport = {
  version: 2;
  ok: boolean;
  cli: { version: string; copy: UpdateChannel; latest: string | null; updateAvailable: boolean };
  launcher: { needed: boolean; present: boolean; executable: boolean; resolvesCli: boolean };
  agents: Record<Agent, AgentReport>;
  notices: { copy: UpdateChannel; kind: "update-available" | "below-minimum"; line: string }[];
};

export async function doctorReport(deps: IntegrationDeps = {}): Promise<DoctorReport> {
  const ins = await inspectIntegrations(deps);
  const plan = planSetup(ins);
  const agents = {} as Record<Agent, AgentReport>;
  for (const agent of AGENTS) agents[agent] = agentReport(ins, agent, plan.find((p) => p.agent === agent)!.action);
  const state = await readState();
  const at = here(deps.script === undefined ? undefined : detectChannel(deps.script));
  const { outdated, notice } = liveVersionRecords(state, at, ins.claude.plugin.version);
  const notices: DoctorReport["notices"] = [
    ...(outdated ? [{ copy: outdated.channel, kind: "below-minimum" as const, line: `${copyLabel(outdated.channel)}: ${outdatedLine(outdated)}` }] : []),
    ...(notice ? [{ copy: notice.channel, kind: "update-available" as const, line: `${copyLabel(notice.channel)}: ${updateNoticeLine(notice)}` }] : []),
  ];
  const latest = state.updateNotice?.latest ?? null;
  const needed = Object.values(agents).some((a) => a.usesLauncher);
  return {
    version: 2,
    // An available update is reported, not failed on: it needs no action to keep collecting.
    ok: Object.values(agents).every((a) => a.status === "ok" || a.status === "not-detected") && !outdated,
    cli: { version: CLI_VERSION, copy: at.channel, latest, updateAvailable: latest !== null && isOlder(CLI_VERSION, latest) },
    launcher: { needed, present: ins.launcher.present, executable: ins.launcher.executable, resolvesCli: ins.launcher.resolvesCli },
    agents,
    notices,
  };
}

function agentReport(ins: Inspection, agent: Agent, fix: Action): AgentReport {
  const state = agent === "claude-code" ? ins.claude : ins.codex;
  const plugin = agent === "claude-code" ? ins.claude.plugin : null;
  const hooks = state.hooks;
  const usesLauncher = hooks.length ? hooks.every((h) => h.form === "launcher") : null;
  const commandResolves = hooks.length ? hooks.every((h) => h.resolves) && (!usesLauncher || ins.launcher.resolvesCli) : null;
  const integration = plugin?.enabled ? "plugin" : hooks.length ? "hook" : "none";
  const status = ((): AgentStatus => {
    if (!state.detected) return "not-detected";
    if (!state.readable) return "unreadable";
    if (plugin?.enabled) return fix === "ok" ? "ok" : "repair";
    if (hooks.length === 0) return "missing";
    if (hooks.length > 1) return "duplicate";
    if (!usesLauncher) return "outdated-pin";
    return commandResolves ? "ok" : "unresolved";
  })();
  return {
    detected: state.detected,
    integration,
    plugin: plugin ? { enabled: plugin.enabled, autoUpdate: plugin.autoUpdate && plugin.release, version: plugin.version } : null,
    hooks: hooks.length,
    usesLauncher,
    commandResolves,
    status,
    fix: status === "ok" || status === "not-detected" ? "ok" : fix,
  };
}

const LABEL: Record<Agent, string> = { "claude-code": "Claude Code", codex: "Codex" };

const SAY: Record<AgentStatus, string> = {
  ok: "ok",
  "not-detected": "not detected",
  unreadable: "its hook file does not parse",
  missing: "not set up: no centrail hook or plugin",
  duplicate: "more than one centrail Stop hook (turns would be recorded twice)",
  "outdated-pin": "outdated pinned command (breaks when Node or centrail moves)",
  unresolved: "hook does not resolve (its launcher or pinned paths are missing)",
  repair: "plugin installed, but auto-update is off or a standalone hook remains",
};

export function printDoctor(r: DoctorReport): void {
  console.log("centrail doctor (read-only)");
  const latest = r.cli.latest ? `; latest known ${r.cli.latest}` : "";
  console.log(`  ${"centrail".padEnd(12)} ${r.cli.version} (${copyLabel(r.cli.copy)})${latest}`);
  for (const agent of AGENTS) {
    const a = r.agents[agent];
    const how = a.plugin?.enabled
      ? `plugin${a.plugin.version ? ` ${a.plugin.version}` : ""}, auto-update ${a.plugin.autoUpdate ? "on" : "off"}`
      : a.usesLauncher
        ? "Stop hook through the launcher"
        : a.hooks
          ? "Stop hook"
          : "";
    const status = a.status === "ok" ? `ok${how ? `: ${how}` : ""}` : SAY[a.status];
    console.log(`  ${LABEL[agent].padEnd(12)} ${status}`);
  }
  if (r.launcher.needed || r.launcher.present) {
    const l = r.launcher;
    const state = !l.present ? "missing" : !l.executable ? "not executable" : l.resolvesCli ? "ok: finds a centrail to run" : "finds no centrail, Node or npx to run";
    console.log(`  ${"launcher".padEnd(12)} ${state}`);
  }
  for (const n of r.notices) console.log(`  ${n.line}`);
  console.log("  Codex hook trust and project/managed hook layers are not checked here: review /hooks in each agent.");
  console.log(r.ok ? "Nothing needs action." : "Needs action: run `centrail doctor --fix` (or `centrail setup`).");
}

export async function runDoctor(opts: { json?: boolean; fix?: boolean; interactive?: boolean }, deps: IntegrationDeps = {}): Promise<DoctorReport> {
  let report = await doctorReport(deps);
  if (opts.fix && !report.ok) {
    const agents = AGENTS.filter((a) => report.agents[a].fix !== "ok" && report.agents[a].fix !== "skip");
    if (agents.length) {
      // --json keeps stdout one JSON line: setup's progress goes to stderr.
      const log = console.log;
      if (opts.json) console.log = (...a: unknown[]) => console.error(...a);
      try {
        await runIntegrationSetup({ agents, yes: true, interactive: opts.interactive }, deps);
      } finally {
        console.log = log;
      }
      report = await doctorReport(deps);
    }
  }
  if (opts.json) console.log(JSON.stringify(report));
  else printDoctor(report);
  if (!report.ok) process.exitCode = 1;
  return report;
}
