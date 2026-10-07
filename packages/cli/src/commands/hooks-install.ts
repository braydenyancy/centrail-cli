import { constants, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { claudeConfigDirs, codexHomeDir } from "@centrail/parsers";
import { stat } from "node:fs/promises";
import { readConfig } from "../config.js";
import { runSetup } from "./scope.js";

// `centrail install-hooks` / `uninstall-hooks`: one Stop entry in Claude
// Code's user settings that runs `centrail hook stop`. Idempotent — an
// existing centrail entry is replaced, every other hook is left exactly as
// found, and the file is rewritten atomically. The command pins the node
// binary and bundle path that ran the install, so the hook keeps working
// without a PATH and never triggers a network resolve per turn — and stops
// working when that node is upgraded away. For Claude Code the plugin is the
// primary path (plugin-setup.ts): its hook runs `node` from PATH, and Claude
// Code keeps its bundle current. This stays for Codex and for anyone
// without the plugin.

type HookCommand = { type: string; command: string; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookCommand[] };
export type Settings = Record<string, unknown> & { hooks?: Record<string, unknown> };

export const HOOK_MARK = "hook stop"; // how a centrail entry is recognised

export function claudeSettingsPath(): string {
  return join(claudeConfigDirs()[0], "settings.json");
}

// Codex reads the same hooks.json shape (`{ "hooks": { "Stop": [...] } }`)
// from its home; its Stop input is Claude-compatible, so the same command
// serves both. Only written when a Codex home already exists.
export function codexHooksPath(): string {
  return join(codexHomeDir(), "hooks.json");
}

export function hookCommand(
  node: string = process.execPath,
  script: string = process.argv[1],
): string {
  const abs = safeRealpath(script);
  return `${quote(node)} ${quote(abs)} hook stop`;
}

export function installStopHook(settings: Settings, command: string): Settings {
  const hooks = isObject(settings.hooks) ? { ...settings.hooks } : {};
  const stop = Array.isArray(hooks.Stop) ? (hooks.Stop as HookGroup[]) : [];
  const kept = stop.filter((g) => !isCentrailGroup(g));
  kept.push({ hooks: [{ type: "command", command, timeout: 10 }] });
  return { ...settings, hooks: { ...hooks, Stop: kept } };
}

export function uninstallStopHook(settings: Settings): Settings {
  if (!isObject(settings.hooks) || !Array.isArray(settings.hooks.Stop)) return settings;
  const kept = (settings.hooks.Stop as HookGroup[]).filter((g) => !isCentrailGroup(g));
  const hooks: Record<string, unknown> = { ...settings.hooks };
  if (kept.length > 0) hooks.Stop = kept;
  else delete hooks.Stop;
  const out: Settings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

export async function runInstallHooks(
  opts: { remove: boolean },
  path = claudeSettingsPath(),
  codexPath: string | null = null,
): Promise<void> {
  if (!opts.remove && !(await readConfig()).scopeDecidedAt) {
    await runSetup({ interactive: process.stdin.isTTY === true });
  }
  const targets = [path];
  const codex = codexPath ?? ((await isDir(codexHomeDir())) ? codexHooksPath() : null);
  if (codex) targets.push(codex);
  for (const target of targets) {
    const { settings, indent } = await readSettingsFile(target);
    if (!opts.remove && target === path && pluginEnabled(settings)) {
      // The plugin's own Stop hook already runs every turn; a second one
      // would only race it.
      console.log(`Claude Code runs centrail through its plugin (${PLUGIN_ID}); no hook added to ${target}.`);
      continue;
    }
    const next = opts.remove ? uninstallStopHook(settings) : installStopHook(settings, hookCommand());
    await writeSettingsFile(target, next, indent);
    console.log(opts.remove ? `Removed the centrail Stop hook from ${target}.` : `Installed the centrail Stop hook in ${target}.`);
  }
  if (opts.remove) return;
  console.log(
    `Every ${codex ? "Claude Code and Codex" : "Claude Code"} turn now records session id, folder, repo identity, branch, head and the\n` +
      "repos its files touched, locally, and starts a background `centrail sync` at most every 10 minutes.\n" +
      "Nothing leaves this machine except what `centrail inspect --last` shows.",
  );
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function isCentrailGroup(g: HookGroup): boolean {
  return (
    isObject(g) &&
    Array.isArray(g.hooks) &&
    g.hooks.some(
      (h) => isObject(h) && typeof h.command === "string" && h.command.includes("centrail") && h.command.includes(HOOK_MARK),
    )
  );
}

export const PLUGIN_ID = "centrail@centrail"; // plugin@marketplace, as Claude Code names it

export function pluginEnabled(settings: Settings): boolean {
  return isObject(settings.enabledPlugins) && settings.enabledPlugins[PLUGIN_ID] === true;
}

// A settings file someone else owns (Claude Code's, Codex's). Missing reads
// as empty; anything but a JSON object throws, so nothing is ever written
// over a file that could not be read. `indent` is the file's own, so a
// rewrite changes the keys it changes and little else.
export async function readSettingsFile(path: string): Promise<{ settings: Settings; indent: string }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, indent: "  " };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Cannot parse ${path}: ${(err as Error).message}`);
  }
  if (!isObject(parsed)) throw new Error(`Cannot parse ${path}: not a JSON object`);
  return { settings: parsed as Settings, indent: /^([ \t]+)"/m.exec(raw)?.[1] ?? "  " };
}

// Atomic (temp file + rename), after a backup.
export async function writeSettingsFile(path: string, settings: Settings, indent = "  "): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await backUpSettings(path);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, indent)}\n`);
  await rename(tmp, path);
}

// The file as centrail first found it, kept once beside it as
// `<name>.centrail-backup` and never overwritten after.
export async function backUpSettings(path: string): Promise<void> {
  try {
    await copyFile(path, `${path}.centrail-backup`, constants.COPYFILE_EXCL);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOENT") throw err;
  }
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
