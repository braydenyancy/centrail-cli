import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, win32 } from "node:path";
import { claudeSettingsPath, codexHooksPath, commandWords, isCentrailCommand, pluginEnabled, readSettingsFile, type Settings } from "./hooks-install.js";

type Finding = { source: "Claude user settings" | "Codex user hooks"; kind: "pinned CLI" | "plugin launcher" | "unattributed plugin launcher"; resolves: boolean };

// Bounded, read-only inspection of the two user files the installer owns.
// Never run a hook or print commands, paths, config values or exception text.
// This is not Codex's active-layer/trust inventory: its own hook UI owns that.
export async function inspectUserHooks(claudePath = claudeSettingsPath(), codexPath = codexHooksPath()) {
  const findings: Finding[] = [];
  const errors: string[] = [];
  let claudePlugin = false;
  for (const [source, path] of [["Claude user settings", claudePath], ["Codex user hooks", codexPath]] as const) {
    let settings: Settings;
    try { settings = (await readSettingsFile(path)).settings; }
    catch { errors.push(`${source}: cannot read configuration`); continue; }
    if (source === "Claude user settings") claudePlugin = pluginEnabled(settings);
    const groups = Array.isArray(settings.hooks?.Stop) ? settings.hooks.Stop : [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) {
        if (handler?.type !== "command" || typeof handler.command !== "string") continue;
        const command = handler.command;
        const words = commandWords(command);
        const pluginLauncher = /^\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}\/scripts\/(?:hook\.sh|centrail\.mjs)$/.test(words?.[1] ?? "");
        const owned = isCentrailCommand(command);
        if (!owned && !pluginLauncher) continue;
        const paths = words?.slice(0, 2) ?? [];
        const absolute = paths.length === 2 && paths.every((p) => isAbsolute(p) || win32.isAbsolute(p));
        const resolves = !pluginLauncher && absolute && (await Promise.all(paths.map(async (p, i) => {
          try { await access(p, i === 0 ? constants.X_OK : constants.R_OK); return true; }
          catch { return false; }
        }))).every(Boolean);
        findings.push({ source, kind: !owned ? "unattributed plugin launcher" : pluginLauncher ? "plugin launcher" : "pinned CLI", resolves });
      }
    }
  }
  const claudeCount = findings.filter((f) => f.source === "Claude user settings" && f.kind !== "unattributed plugin launcher").length + Number(claudePlugin);
  const codexCount = findings.filter((f) => f.source === "Codex user hooks" && f.kind !== "unattributed plugin launcher").length;
  return { claudePlugin, findings, errors, possibleDuplicates: claudeCount > 1 || codexCount > 1 };
}

export async function runHooksDoctor(claudePath?: string, codexPath?: string): Promise<void> {
  const report = await inspectUserHooks(claudePath, codexPath);
  console.log("Centrail hook check — user installation files only (read-only)");
  console.log(`Claude user plugin setting: ${report.claudePlugin ? "enabled; plugin owns its launcher" : "disabled/absent; standalone hook expected"}`);
  for (const finding of report.findings) {
    console.log(`${finding.source}: ${finding.kind}; ${finding.resolves ? "executable and bundle resolve" : "unresolved or requires plugin context"}`);
  }
  for (const error of report.errors) console.log(error);
  console.log(`Possible duplicate user hooks: ${report.possibleDuplicates ? "yes" : "none found"}`);
  console.log("Generic plugin-root launchers have ambiguous ownership and are never removed automatically.");
  console.log("Active project/managed/TOML/plugin-cache hooks and trust are not verified here. Review Codex's hook inventory and Claude's /hooks; restart/reload after changes.");
}
