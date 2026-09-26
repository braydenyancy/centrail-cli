import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { claudeConfigDirs } from "@centrail/parsers";

// `centrail install-hooks` / `uninstall-hooks`: one Stop entry in Claude
// Code's user settings that runs `centrail hook stop`. Idempotent — an
// existing centrail entry is replaced, every other hook is left exactly as
// found, and the file is rewritten atomically. The command pins the node
// binary and bundle path that ran the install, so the hook keeps working
// without a PATH and never triggers a network resolve per turn.

type HookCommand = { type: string; command: string; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookCommand[] };
type Settings = Record<string, unknown> & { hooks?: Record<string, unknown> };

export const HOOK_MARK = "hook stop"; // how a centrail entry is recognised

export function claudeSettingsPath(): string {
  return join(claudeConfigDirs()[0], "settings.json");
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

export async function runInstallHooks(opts: { remove: boolean }, path = claudeSettingsPath()): Promise<void> {
  const settings = await readSettings(path);
  const next = opts.remove ? uninstallStopHook(settings) : installStopHook(settings, hookCommand());
  await writeSettings(path, next);
  if (opts.remove) {
    console.log(`Removed the centrail Stop hook from ${path}.`);
    return;
  }
  console.log(`Installed the centrail Stop hook in ${path}.`);
  console.log(
    "Every Claude Code turn now records session id, folder, repo identity, branch and head\n" +
      "locally and starts a background `centrail sync` at most every 10 minutes.\n" +
      "Nothing leaves this machine except what `centrail inspect --last` shows.",
  );
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

async function readSettings(path: string): Promise<Settings> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
    return isObject(parsed) ? (parsed as Settings) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot parse ${path}: ${(err as Error).message}`);
  }
}

async function writeSettings(path: string, settings: Settings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  await rename(tmp, path);
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
