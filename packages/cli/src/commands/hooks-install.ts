import { constants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { claudeConfigDirs, codexHomeDir } from "@centrail/parsers";
import { replaceFile } from "../config.js";
import { safeRealpath, stableInstallPath } from "../launcher.js";

export { stableInstallPath } from "../launcher.js";

// The hook entries centrail owns in a harness's user hook file (Claude Code's
// settings.json, Codex's hooks.json; both `{ "hooks": { "Stop": [...] } }`).
// `centrail setup` writes one Stop entry running the stable launcher
// (launcher.ts) with fixed arguments; `centrail uninstall` removes it. Every
// form an earlier release wrote is recognised, so a rerun replaces it: the
// pinned `"<node>" "<bundle>" hook stop --centrail-hook`, direct-node and
// absolute plugin launchers. Every other hook is left exactly as found, and
// the file is rewritten atomically after a one-time backup.
export type Settings = Record<string, unknown> & { hooks?: Record<string, unknown> };

export const HOOK_MARK = "hook stop"; // legacy invocation, qualified by launcher ownership below

export function claudeSettingsPath(): string {
  return join(claudeConfigDirs()[0], "settings.json");
}

// Codex reads the same hooks.json shape from its home. Compatible input does
// not make Claude's plugin launcher portable: Codex gets the stable launcher.
export function codexHooksPath(): string {
  return join(codexHomeDir(), "hooks.json");
}

// The Stop command for a harness: the launcher path, quoted for the shell
// the harness runs hooks with, and fixed arguments. `--centrail-hook` is
// the ownership marker; `--surface codex` selects Codex's JSON output.
export function launcherCommand(launcher: string, surface: "claude-code" | "codex", platform: NodeJS.Platform = process.platform): string {
  return `${quote(launcher, platform)} ${HOOK_MARK} --centrail-hook${surface === "codex" ? " --surface codex" : ""}`;
}

// The pinned form 0.7.4–0.8.x wrote (absolute Node and bundle). Recognised
// for migration; never written any more.
export function hookCommand(
  node: string = process.execPath,
  script: string = process.argv[1],
  platform: NodeJS.Platform = process.platform,
): string {
  const abs = stableInstallPath(safeRealpath(script));
  return `${quote(stableInstallPath(node), platform)} ${quote(abs, platform)} hook stop --centrail-hook`;
}

export function installStopHook(settings: Settings, command: string): Settings {
  const hooks = isObject(settings.hooks) ? { ...settings.hooks } : {};
  const cleaned = uninstallStopHook(settings);
  const kept = Array.isArray(cleaned.hooks?.Stop) ? [...cleaned.hooks.Stop] : [];
  kept.push({ hooks: [{ type: "command", command, timeout: 10 }] });
  return { ...settings, hooks: { ...hooks, Stop: kept } };
}

export function uninstallStopHook(settings: Settings): Settings {
  if (!isObject(settings.hooks) || !Array.isArray(settings.hooks.Stop)) return settings;
  const kept = (settings.hooks.Stop as unknown[]).flatMap((g) => {
    if (!isObject(g) || !Array.isArray(g.hooks)) return [g];
    const handlers = g.hooks.filter((h) => !isObject(h) || h.type !== "command" || typeof h.command !== "string" || !isCentrailCommand(h.command));
    if (handlers.length === g.hooks.length) return [g];
    return handlers.length ? [{ ...g, hooks: handlers }] : [];
  });
  const hooks: Record<string, unknown> = { ...settings.hooks };
  if (kept.length > 0) hooks.Stop = kept;
  else delete hooks.Stop;
  const out: Settings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

// Recognise emitted launch forms, not arbitrary text mentioning Centrail.
// A generic ${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh has no ownership evidence:
// many other plugins use it. Never remove it just because it sits beside ours.
export function commandWords(command: string): string[] | null {
  const words: string[] = [];
  // Emitted Windows paths keep backslashes literal. POSIX double quotes
  // escape only backslash, quote, dollar and backtick. This isn't a shell:
  // reject expansions/compound commands outside quoted path tokens.
  const windows = /"(?:[a-z]:\\|\\\\)/i.test(command);
  let word = "", quoted = "", started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (/[\n\r]/.test(char)) return null;
    if (quoted) {
      if (char === quoted) quoted = "";
      else if (!windows && quoted === '"' && char === "\\" && /[\\"$`]/.test(command[i + 1] ?? "")) word += command[++i];
      else word += char;
    } else if (char === '"' || char === "'") { quoted = char; started = true; }
    else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = ""; started = false;
    } else {
      if (/[;&|<>$`]/.test(char)) return null;
      word += char; started = true;
    }
  }
  if (quoted) return null;
  if (started) words.push(word);
  return words;
}

export function isCentrailCommand(command: string): boolean {
  const words = commandWords(command);
  if (!words) return false;
  const normal = words.map((w) => w.replaceAll("\\", "/"));
  const base = (s: string) => s.split("/").pop() ?? "";
  const cli = (s: string) => /(?:^|\/)centrail(?:\.cmd|\.exe|@[^/]*)?$/.test(s);
  const bundle = (s: string) => /(?:^|\/)centrail(?:[-@][^/]*)?\/(?:.*\/)?(?:index\.js|centrail\.mjs)$/.test(s) || /\/scripts\/centrail\.mjs$/.test(s);
  const stopArgs = (args: string[]) => [HOOK_MARK, `${HOOK_MARK} --surface codex`, `${HOOK_MARK} --centrail-hook`, `${HOOK_MARK} --centrail-hook --surface codex`].includes(args.join(" "));
  const absolute = (s: string) => isAbsolute(s) || win32.isAbsolute(s);
  if (absolute(words[0] ?? "") && /^centrail-hook(?:\.cmd)?$/.test(base(normal[0] ?? "")) && words.includes("--centrail-hook") && stopArgs(words.slice(1))) return true;
  if (words.slice(2).includes("--centrail-hook") && stopArgs(words.slice(2)) && absolute(words[0] ?? "") && absolute(words[1] ?? "")) return true;
  if (cli(normal[0] ?? "") && stopArgs(normal.slice(1))) return true;
  if (/^node(?:\.exe)?$/.test(base(normal[0] ?? "")) && stopArgs(normal.slice(2)) && (words.includes("--centrail-hook") || bundle(normal[1] ?? ""))) return true;
  if (/^npx(?:\.cmd)?$/.test(base(normal[0] ?? ""))) {
    const args = normal.slice(1);
    if (args[0] === "-y" || args[0] === "--yes") args.shift();
    return cli(args[0] ?? "") && stopArgs(args.slice(1));
  }
  return normal.length === 2 && /^(?:sh|bash)(?:\.exe)?$/.test(base(normal[0])) && /\/centrail\/(?:[^/]+\/)?scripts\/hook\.sh$/.test(normal[1]);
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
  await replaceFile(tmp, path);
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

function quote(s: string, platform: NodeJS.Platform): string {
  if (/[\n\r]/.test(s)) throw new Error("Cannot install a hook with a newline in an executable path.");
  if (platform === "win32") {
    if (/["%]/.test(s)) throw new Error("Cannot install a Windows hook with quotes or percent expansion in an executable path.");
    return `"${s}"`;
  }
  return `"${s.replace(/[\\"$`]/g, "\\$&")}"`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
