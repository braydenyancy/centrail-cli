import { homedir } from "node:os";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { codexHomeDir, piSessionsDir } from "@centrail/parsers";
import { replaceFile } from "../config.js";
import { homeOverrides } from "../home-overrides.js";
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

export type HookAgent = "codex" | "gemini-cli" | "copilot-cli" | "pi" | "cursor" | "opencode";

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
  usage: boolean; // a log scanner reads its usage; false: the entry records repo identity only
  module?: boolean; // the entry is a whole generated file (an extension or plugin)
  fileName: string; // for messages: the file centrail writes, relative to `home`
  file: (home: string) => string;
  read: (file: string, launcher: string, platform: NodeJS.Platform) => Promise<HookFile>;
  install: (file: string, launcher: string, platform: NodeJS.Platform) => Promise<void>;
  uninstall: (file: string) => Promise<void>;
};

// Default homes, from the variables each agent itself honours. Cursor names
// none: its user hooks are always `~/.cursor/hooks.json`, so tests redirect
// the defaults themselves (home-overrides.ts).

export function defaultHome(agent: HookAgent, env: NodeJS.ProcessEnv = process.env): string {
  const forTests = homeOverrides[agent];
  if (forTests) return forTests;
  if (agent === "codex") return codexHomeDir();
  // GEMINI_CLI_HOME replaces the home directory, not the .gemini inside it.
  if (agent === "gemini-cli") return join(env.GEMINI_CLI_HOME || homedir(), ".gemini");
  if (agent === "copilot-cli") return env.COPILOT_HOME || join(homedir(), ".copilot");
  if (agent === "cursor") return join(homedir(), ".cursor");
  if (agent === "opencode") return opencodeConfigDir(env);
  return dirname(piSessionsDir()); // PI_CODING_AGENT_DIR, else ~/.pi/agent
}

// OpenCode's global config dir, always loaded: `$XDG_CONFIG_HOME/opencode`,
// else `~/.config/opencode` (Windows too). OPENCODE_CONFIG_DIR adds a
// directory to it rather than replacing it, so it is not followed.
export function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
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
    usage: true,
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

// A file of flat entries under `hooks.<event>`, each naming its command in
// one key (no handler groups), with `version: 1` at the top.
//   Copilot CLI loads every `*.json` in its user hooks dir; centrail owns one,
//     `centrail.json`: a `bash` command on macOS/Linux, `powershell` on Windows.
//   Cursor reads `~/.cursor/hooks.json`, shared with the user's own hooks:
//     `command`, run through PowerShell on Windows.
// Uninstall removes the file once only centrail's entry was in it.
function flatHook(o: {
  agent: HookAgent;
  label: string;
  bin: string;
  how: string;
  fileName: string;
  event: string;
  key: (platform: NodeJS.Platform) => string; // where the command goes
  keys: readonly string[]; // every key a command is read from
  extra: Record<string, unknown>;
  usage?: boolean;
}): AgentHook {
  const owns = (e: unknown) => isObject(e) && o.keys.some((k) => typeof e[k] === "string" && isCentrailCommand(e[k] as string));
  const entries = (settings: Settings): unknown[] => (Array.isArray(settings.hooks?.[o.event]) ? (settings.hooks[o.event] as unknown[]) : []);
  const without = (settings: Settings): Settings => {
    const hooks = isObject(settings.hooks) ? { ...settings.hooks } : {};
    const kept = entries(settings).filter((e) => !owns(e));
    if (kept.length) hooks[o.event] = kept;
    else delete hooks[o.event];
    return { ...settings, hooks };
  };
  const command = (launcher: string, platform: NodeJS.Platform) => launcherCommand(launcher, o.agent, platform, { powershell: true });
  return {
    agent: o.agent,
    label: o.label,
    bin: o.bin,
    how: o.how,
    usage: o.usage ?? true,
    fileName: o.fileName,
    file: (home) => join(home, o.fileName),
    async read(file, launcher, platform) {
      const settings = await readJson(file);
      if (!settings) return { readable: false, hooks: [] };
      const commands = entries(settings).flatMap((e) => (isObject(e) ? o.keys.map((k) => e[k]).filter((c): c is string => typeof c === "string") : []));
      const expected = command(launcher, platform);
      return { readable: true, hooks: await Promise.all(commands.filter(isCentrailCommand).map((c) => classifyCommand(c, expected, platform))) };
    },
    async install(file, launcher, platform) {
      const { settings, indent } = await readSettingsFile(file);
      const next = without(settings);
      const entry = { type: "command", [o.key(platform)]: command(launcher, platform), ...o.extra };
      await writeSettingsFile(file, { version: 1, ...next, hooks: { ...next.hooks, [o.event]: [...entries(next), entry] } }, indent);
    },
    async uninstall(file) {
      const { settings, indent } = await readSettingsFile(file);
      const next = without(settings);
      // Only centrail's entry was in it: the file goes, as it came.
      const rest = Object.keys(next).filter((k) => k !== "version" && !(k === "hooks" && Object.keys(next.hooks ?? {}).length === 0));
      if (rest.length === 0) await rm(file, { force: true });
      else await writeSettingsFile(file, next, indent);
    },
  };
}

// Agents without a hook file run per-turn code as a module they load at
// start: Pi an extension, OpenCode a plugin. centrail's is one generated file
// that, at the end of each turn, hands the launcher a hook payload on stdin
// and leaves it running detached, so the agent never waits on it. Both load
// plain JavaScript; the module imports nothing of the agent's. A file is
// centrail's by the mark in its first line; one without it is never touched.

// Starts `launcher args` detached with `input` on stdin; never throws.
const spawnLauncher = (detached: string) => `function run(input) {
  try {
    const options = { detached: ${detached}, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] };
    // A .cmd runs only through a shell on Windows.
    const child = process.platform === "win32"
      ? spawn(\`"\${launcher}"\`, args, { ...options, shell: true })
      : spawn(launcher, args, options);
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
    child.unref();
  } catch {
    // never break the agent over a sync
  }
}`;

function moduleHeader(mark: string, agent: HookAgent, launcher: string, what: string, detached = "true"): string {
  return `// ${mark}: written by \`centrail setup\`, rewritten by each setup,
// removed by \`centrail uninstall\`; do not edit. ${what}
import { spawn } from "node:child_process";

const launcher = ${JSON.stringify(launcher)};
const args = ["hook", "stop", "--centrail-hook", "--surface", "${agent}"];

${spawnLauncher(detached)}
`;
}

// Pi: `<agent dir>/extensions/centrail.js`, a default export taking the
// extension API; `agent_end` fires once per run.
export const PI_EXTENSION_MARK = "centrail-pi-extension";

export function piExtension(launcher: string): string {
  return `${moduleHeader(PI_EXTENSION_MARK, "pi", launcher, `After each agent run it starts
// centrail's stable launcher (--centrail-hook --surface pi) in the background
// with the session id and folder on stdin. Pi does not wait for it.`)}
export default function centrail(pi) {
  pi.on("agent_end", (_event, ctx) => {
    try {
      run({ hook_event_name: "agent_end", session_id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd });
    } catch {
      // never break the agent over a sync
    }
  });
}
`;
}

// The launcher a centrail module runs, or null when the file is not centrail's.
export function moduleLauncher(content: string, mark: string): string | null {
  if (!content.split("\n", 1)[0].includes(mark)) return null;
  const m = /^const launcher = ("(?:[^"\\]|\\.)*");$/m.exec(content);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as string;
  } catch {
    return null;
  }
}

export const piExtensionLauncher = (content: string) => moduleLauncher(content, PI_EXTENSION_MARK);

function moduleHook(o: { agent: HookAgent; label: string; bin: string; how: string; fileName: string; mark: string; render: (launcher: string) => string; usage?: boolean }): AgentHook {
  return {
    agent: o.agent,
    label: o.label,
    bin: o.bin,
    how: o.how,
    usage: o.usage ?? true,
    module: true,
    fileName: o.fileName,
    file: (home) => join(home, o.fileName),
    async read(file, launcher, platform) {
      let content: string;
      try {
        content = await readFile(file, "utf-8");
      } catch {
        return { readable: true, hooks: [] };
      }
      const runs = moduleLauncher(content, o.mark);
      if (runs === null) return { readable: false, hooks: [] }; // someone else's file
      return { readable: true, hooks: [{ form: "launcher", current: content === o.render(launcher), resolves: await isExecutable(runs, platform) }] };
    },
    async install(file, launcher) {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, o.render(launcher));
      await replaceFile(tmp, file);
    },
    async uninstall(file) {
      const content = await readFile(file, "utf-8").catch(() => null);
      if (content !== null && moduleLauncher(content, o.mark) !== null) await rm(file, { force: true });
    },
  };
}

// OpenCode (v1, npm `opencode-ai`): `<config dir>/plugins/centrail.js`, every
// export a plugin function returning hooks. `session.status` with an idle
// status ends each prompt's run; the deprecated `session.idle` is published
// with it, and is taken too for releases before `session.status`, once per
// session per moment. A subagent's child session (with a `parentID`) goes
// idle too and is not a turn. The session's own folder comes from the
// session, not the plugin's: one OpenCode server serves many. OpenCode
// starts no detached child on Windows itself, and neither does this.
export const OPENCODE_PLUGIN_MARK = "centrail-opencode-plugin";

export function opencodePlugin(launcher: string): string {
  return `${moduleHeader(
    OPENCODE_PLUGIN_MARK,
    "opencode",
    launcher,
    `When a session goes idle (a prompt's
// run ended) it starts centrail's stable launcher (--centrail-hook --surface
// opencode) in the background with the session id and folder on stdin.
// OpenCode does not wait for it.`,
    'process.platform !== "win32"',
  )}
const recent = new Map();

export const CentrailPlugin = async ({ client, directory }) => ({
  event: async ({ event }) => {
    try {
      const idle = event.type === "session.idle" || (event.type === "session.status" && event.properties?.status?.type === "idle");
      const id = event.properties?.sessionID;
      if (!idle || typeof id !== "string") return;
      const now = Date.now();
      if (now - (recent.get(id) ?? 0) < 2000) return; // session.status and session.idle, together
      recent.set(id, now);
      let session;
      try {
        session = (await client.session.get({ path: { id } })).data;
      } catch {
        // an older server: place it by the plugin's folder
      }
      if (session?.parentID) return;
      run({ hook_event_name: "session.idle", session_id: id, cwd: session?.directory || directory });
    } catch {
      // never break the agent over a sync
    }
  },
});
`;
}

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
  flatHook({
    agent: "copilot-cli",
    label: "Copilot CLI",
    bin: "copilot",
    how: "agentStop hook",
    fileName: join("hooks", "centrail.json"),
    event: "agentStop",
    key: (platform) => (platform === "win32" ? "powershell" : "bash"),
    keys: ["bash", "powershell", "command"],
    extra: { timeoutSec: 10 },
  }),
  moduleHook({ agent: "pi", label: "Pi", bin: "pi", how: "extension", fileName: join("extensions", "centrail.js"), mark: PI_EXTENSION_MARK, render: piExtension }),
  // No usage scanner reads Cursor's or OpenCode's logs yet: their entries
  // record repo identity only, and setup adds them only when named.
  flatHook({
    agent: "cursor",
    label: "Cursor",
    bin: "cursor",
    how: "stop hook",
    fileName: "hooks.json",
    event: "stop",
    // Cursor runs hook commands through PowerShell on Windows.
    key: () => "command",
    keys: ["command"],
    extra: { timeout: 10 },
    usage: false,
  }),
  moduleHook({ agent: "opencode", label: "OpenCode", bin: "opencode", how: "plugin", fileName: join("plugins", "centrail.js"), mark: OPENCODE_PLUGIN_MARK, render: opencodePlugin, usage: false }),
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
