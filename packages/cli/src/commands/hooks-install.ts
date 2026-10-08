import { constants, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { claudeConfigDirs, codexHomeDir } from "@centrail/parsers";
import { stat } from "node:fs/promises";
import { readConfig, replaceFile } from "../config.js";
import { runSetup } from "./scope.js";

// `centrail install-hooks` / `uninstall-hooks`: one Stop entry in Claude
// Code's user settings that runs `centrail hook stop`. Idempotent — an
// existing centrail entry is replaced, every other hook is left exactly as
// found, and the file is rewritten atomically. The command pins the node
// binary and bundle path that ran the install, so the hook keeps working
// without a PATH and never triggers a network resolve per turn — and stops
// working when that node is upgraded away. For Claude Code the plugin is the
// primary path (plugin-setup.ts): its shell launcher discovers Node, and Claude
// Code keeps its bundle current. Launchers are harness-specific. This stays
// for Codex and for anyone without the plugin.
export type Settings = Record<string, unknown> & { hooks?: Record<string, unknown> };

export const HOOK_MARK = "hook stop"; // legacy invocation, qualified by launcher ownership below

export function claudeSettingsPath(): string {
  return join(claudeConfigDirs()[0], "settings.json");
}

// Codex reads the same hooks.json shape (`{ "hooks": { "Stop": [...] } }`)
// from its home. Compatible input does not make Claude's plugin launcher
// portable: Codex gets an explicit pinned command. Only written when its home exists.
export function codexHooksPath(): string {
  return join(codexHomeDir(), "hooks.json");
}

export function hookCommand(
  node: string = process.execPath,
  script: string = process.argv[1],
  platform: NodeJS.Platform = process.platform,
): string {
  const abs = safeRealpath(script);
  return `${quote(node, platform)} ${quote(abs, platform)} hook stop --centrail-hook`;
}

export function codexHookCommand(node = process.execPath, script = process.argv[1], platform: NodeJS.Platform = process.platform): string {
  requireStandaloneBundle(script);
  return `${hookCommand(node, script, platform)} --surface codex`;
}

function requireStandaloneBundle(script: string): void {
  if (/[\\/]scripts[\\/]centrail\.mjs$/.test(safeRealpath(script))) {
    throw new Error("Install explicit hooks from a standalone Centrail CLI installation, then run centrail install-hooks. A plugin bundle cannot own the Codex launcher.");
  }
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

export async function runInstallHooks(
  opts: { remove: boolean },
  path = claudeSettingsPath(),
  codexPath: string | null = null,
): Promise<void> {
  // Refuse before scope/setup or user settings writes: otherwise a plugin
  // invocation could pin Codex to a cache directory its harness can replace.
  if (!opts.remove) requireStandaloneBundle(process.argv[1]);
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
      const next = uninstallStopHook(settings);
      if (JSON.stringify(next) !== JSON.stringify(settings)) await writeSettingsFile(target, next, indent);
      console.log(`Claude Code runs centrail through its plugin (${PLUGIN_ID}); obsolete standalone Centrail hooks removed, no hook added.`);
      continue;
    }
    const next = opts.remove ? uninstallStopHook(settings) : installStopHook(settings, target === codex ? codexHookCommand() : hookCommand());
    await writeSettingsFile(target, next, indent);
    console.log(opts.remove ? `Removed the centrail Stop hook from ${target}.` : `Installed the centrail Stop hook in ${target}.`);
  }
  if (opts.remove) return;
  if (codex) console.log("Codex: review and trust the updated user hook, then reload/restart sessions. Other config layers and plugin caches are not edited.");
  console.log(
    `Once the hooks are enabled and trusted, each ${codex ? "Claude Code and Codex" : "Claude Code"} turn records session id, folder, repo identity, branch, head and the\n` +
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

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
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
