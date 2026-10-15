import { homedir } from "node:os";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { codexHomeDir, piSessionsDir } from "@centrail/parsers";
import { replaceFile } from "../config.js";
import { isExecutable } from "../launcher.js";
import {
  commandWords,
  groupCommands,
  installStopHook,
  isCentrailCommand,
  launcherCommand,
  readSettingsFile,
  uninstallStopHook,
  writeSettingsFile,
  type Settings,
} from "./hooks-install.js";

// The agents centrail reaches through one hook entry of its own, each in the
// agent's native per-turn mechanism, all running the stable launcher with
// fixed arguments (docs/integrations.md § Per agent):
//
//   Codex        $CODEX_HOME/hooks.json            hooks.Stop        (seconds)
//   Gemini CLI   ~/.gemini/settings.json           hooks.AfterAgent  (ms)
//   Copilot CLI  $COPILOT_HOME/hooks/centrail.json  hooks.agentStop   (a file of centrail's)
//   Pi           <agent dir>/extensions/centrail.js agent_end        (a file of centrail's)
//
// Claude Code is not here: it gets centrail's plugin (integrations.ts).

export type HookAgent = "codex" | "gemini-cli" | "copilot-cli" | "pi";

export type HookFinding = {
  form: "launcher" | "pinned" | "other"; // launcher: today's; pinned: 0.7.4–0.8.x; other: older forms
  current: boolean; // exactly what setup writes now
  resolves: boolean; // its executable (and bundle) exist
};

// `readable: false` — the file does not parse, or (Pi) a centrail.js that is
// not centrail's sits where centrail's would go: nothing is written over it.
export type HookFile = { readable: boolean; hooks: HookFinding[] };

export type AgentHook = {
  agent: HookAgent;
  label: string;
  bin: string; // its command, for detection
  how: string; // what doctor calls the entry
  fileName: string; // for messages: the file centrail writes, relative to `home`
  file: (home: string) => string;
  read: (file: string, launcher: string, platform: NodeJS.Platform) => Promise<HookFile>;
  install: (file: string, launcher: string, platform: NodeJS.Platform) => Promise<void>;
  uninstall: (file: string) => Promise<void>;
};

// Default homes, from the variables each agent itself honours.
export function defaultHome(agent: HookAgent, env: NodeJS.ProcessEnv = process.env): string {
  if (agent === "codex") return codexHomeDir();
  // GEMINI_CLI_HOME replaces the home directory, not the .gemini inside it.
  if (agent === "gemini-cli") return join(env.GEMINI_CLI_HOME || homedir(), ".gemini");
  if (agent === "copilot-cli") return env.COPILOT_HOME || join(homedir(), ".copilot");
  return dirname(piSessionsDir()); // PI_CODING_AGENT_DIR, else ~/.pi/agent
}

// A command-string entry, classified against the one setup writes now.
export async function classifyCommand(command: string, expected: string, platform: NodeJS.Platform): Promise<HookFinding> {
  const words = commandWords(command) ?? [];
  const launcherForm = /(?:^|[\\/])centrail-hook(?:\.cmd)?$/.test(words[0] ?? "");
  const absolute = words.slice(0, 2).filter((w) => isAbsolute(w) || win32.isAbsolute(w));
  const pinned = !launcherForm && absolute.length === 2;
  const resolves = launcherForm ? await isExecutable(words[0], platform) : pinned && (await Promise.all(absolute.map(exists))).every(Boolean);
  return { form: launcherForm ? "launcher" : pinned ? "pinned" : "other", current: command === expected, resolves };
}

async function readJson(file: string): Promise<Settings | null> {
  try {
    return (await readSettingsFile(file)).settings;
  } catch {
    return null;
  }
}

// Codex and Gemini CLI: a handler group under `hooks.<event>` in a settings
// file shared with the user's own hooks, which stay exactly as found.
function groupHook(o: {
  agent: HookAgent;
  label: string;
  bin: string;
  how: string;
  fileName: string;
  event: string;
  handler: Record<string, unknown>;
  powershell: boolean;
}): AgentHook {
  const command = (launcher: string, platform: NodeJS.Platform) => launcherCommand(launcher, o.agent, platform, { powershell: o.powershell });
  return {
    agent: o.agent,
    label: o.label,
    bin: o.bin,
    how: o.how,
    fileName: o.fileName,
    file: (home) => join(home, o.fileName),
    async read(file, launcher, platform) {
      const settings = await readJson(file);
      if (!settings) return { readable: false, hooks: [] };
      const expected = command(launcher, platform);
      const hooks = await Promise.all(groupCommands(settings, o.event).filter(isCentrailCommand).map((c) => classifyCommand(c, expected, platform)));
      return { readable: true, hooks };
    },
    async install(file, launcher, platform) {
      const { settings, indent } = await readSettingsFile(file);
      await writeSettingsFile(file, installStopHook(settings, command(launcher, platform), o.event, o.handler), indent);
    },
    async uninstall(file) {
      const { settings, indent } = await readSettingsFile(file);
      await writeSettingsFile(file, uninstallStopHook(settings, o.event), indent);
    },
  };
}

// Copilot CLI loads every `*.json` in its user hooks dir; centrail owns one,
// `centrail.json`. Its entries are flat (no groups), with a `bash` command on
// macOS/Linux and a `powershell` one on Windows.
const COPILOT_EVENT = "agentStop";
const copilotCommands = (settings: Settings): string[] => {
  const entries = Array.isArray(settings.hooks?.[COPILOT_EVENT]) ? (settings.hooks[COPILOT_EVENT] as unknown[]) : [];
  return entries.flatMap((e) => (isObject(e) ? ["bash", "powershell", "command"].map((k) => e[k]).filter((c): c is string => typeof c === "string") : []));
};
const ownsCopilotEntry = (e: unknown) => isObject(e) && ["bash", "powershell", "command"].some((k) => typeof e[k] === "string" && isCentrailCommand(e[k] as string));

function withoutCopilotEntries(settings: Settings): Settings {
  const hooks = isObject(settings.hooks) ? { ...settings.hooks } : {};
  const kept = Array.isArray(hooks[COPILOT_EVENT]) ? (hooks[COPILOT_EVENT] as unknown[]).filter((e) => !ownsCopilotEntry(e)) : [];
  if (kept.length) hooks[COPILOT_EVENT] = kept;
  else delete hooks[COPILOT_EVENT];
  return { ...settings, hooks };
}

const copilotHook: AgentHook = {
  agent: "copilot-cli",
  label: "Copilot CLI",
  bin: "copilot",
  how: "agentStop hook",
  fileName: join("hooks", "centrail.json"),
  file: (home) => join(home, "hooks", "centrail.json"),
  async read(file, launcher, platform) {
    const settings = await readJson(file);
    if (!settings) return { readable: false, hooks: [] };
    const expected = launcherCommand(launcher, "copilot-cli", platform, { powershell: true });
    const hooks = await Promise.all(copilotCommands(settings).filter(isCentrailCommand).map((c) => classifyCommand(c, expected, platform)));
    return { readable: true, hooks };
  },
  async install(file, launcher, platform) {
    const { settings, indent } = await readSettingsFile(file);
    const next = withoutCopilotEntries(settings);
    const shell = platform === "win32" ? "powershell" : "bash";
    const entries = Array.isArray(next.hooks?.[COPILOT_EVENT]) ? (next.hooks[COPILOT_EVENT] as unknown[]) : [];
    const entry = { type: "command", [shell]: launcherCommand(launcher, "copilot-cli", platform, { powershell: true }), timeoutSec: 10 };
    await writeSettingsFile(file, { version: 1, ...next, hooks: { ...next.hooks, [COPILOT_EVENT]: [...entries, entry] } }, indent);
  },
  async uninstall(file) {
    const { settings, indent } = await readSettingsFile(file);
    const next = withoutCopilotEntries(settings);
    // Only centrail's entry was in it: the file goes, as it came.
    const rest = Object.keys(next).filter((k) => k !== "version" && !(k === "hooks" && Object.keys(next.hooks ?? {}).length === 0));
    if (rest.length === 0) await rm(file, { force: true });
    else await writeSettingsFile(file, next, indent);
  },
};

// Pi has no hook file: per-turn code runs as an extension, a module Pi loads
// from `<agent dir>/extensions/`. centrail's is one generated file that, at
// each `agent_end`, hands the launcher a hook payload on stdin and leaves it
// running detached, so Pi never waits on it. Pi loads plain JavaScript
// through jiti; the module imports nothing of Pi's.
export const PI_EXTENSION_MARK = "centrail-pi-extension";

export function piExtension(launcher: string): string {
  return `// ${PI_EXTENSION_MARK}: written by \`centrail setup\`, rewritten by each setup,
// removed by \`centrail uninstall\`; do not edit. After each agent run it starts
// centrail's stable launcher (--centrail-hook --surface pi) in the background
// with the session id and folder on stdin. Pi does not wait for it.
import { spawn } from "node:child_process";

const launcher = ${JSON.stringify(launcher)};
const args = ["hook", "stop", "--centrail-hook", "--surface", "pi"];

export default function centrail(pi) {
  pi.on("agent_end", (_event, ctx) => {
    try {
      const input = JSON.stringify({
        hook_event_name: "agent_end",
        session_id: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
      });
      const options = { detached: true, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] };
      // A .cmd runs only through a shell on Windows.
      const child = process.platform === "win32"
        ? spawn(\`"\${launcher}"\`, args, { ...options, shell: true })
        : spawn(launcher, args, options);
      child.on("error", () => {});
      child.stdin.on("error", () => {});
      child.stdin.end(input);
      child.unref();
    } catch {
      // never break the agent over a sync
    }
  });
}
`;
}

// The launcher a centrail Pi extension runs, or null when the file is not centrail's.
export function piExtensionLauncher(content: string): string | null {
  if (!content.includes(PI_EXTENSION_MARK)) return null;
  const m = /^const launcher = ("(?:[^"\\]|\\.)*");$/m.exec(content);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as string;
  } catch {
    return null;
  }
}

const piHook: AgentHook = {
  agent: "pi",
  label: "Pi",
  bin: "pi",
  how: "extension",
  fileName: join("extensions", "centrail.js"),
  file: (home) => join(home, "extensions", "centrail.js"),
  async read(file, launcher, platform) {
    let content: string;
    try {
      content = await readFile(file, "utf-8");
    } catch {
      return { readable: true, hooks: [] };
    }
    const runs = piExtensionLauncher(content);
    if (runs === null) return { readable: false, hooks: [] }; // someone else's centrail.js
    return { readable: true, hooks: [{ form: "launcher", current: content === piExtension(launcher), resolves: await isExecutable(runs, platform) }] };
  },
  async install(file, launcher) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, piExtension(launcher));
    await replaceFile(tmp, file);
  },
  async uninstall(file) {
    const content = await readFile(file, "utf-8").catch(() => null);
    if (content !== null && piExtensionLauncher(content) !== null) await rm(file, { force: true });
  },
};

export const AGENT_HOOKS: readonly AgentHook[] = [
  groupHook({ agent: "codex", label: "Codex", bin: "codex", how: "Stop hook", fileName: "hooks.json", event: "Stop", handler: { timeout: 10 }, powershell: false }),
  groupHook({
    agent: "gemini-cli",
    label: "Gemini CLI",
    bin: "gemini",
    how: "AfterAgent hook",
    fileName: "settings.json",
    event: "AfterAgent",
    handler: { name: "centrail", timeout: 10000 },
    // Gemini CLI runs hook commands through PowerShell on Windows.
    powershell: true,
  }),
  copilotHook,
  piHook,
];

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
