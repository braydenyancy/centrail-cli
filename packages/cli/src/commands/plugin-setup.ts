import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { readConfig, updateConfig } from "../config.js";
import {
  backUpSettings,
  claudeSettingsPath,
  PLUGIN_ID,
  readSettingsFile,
  uninstallStopHook,
  writeSettingsFile,
  type Settings,
} from "./hooks-install.js";

// The Claude Code plugin is the primary hook path, and Claude Code keeps it
// current (decision B, 2026-10-07): the CLI never installs itself. Claude
// Code auto-updates a third-party marketplace only when its
// `extraKnownMarketplaces` entry says `autoUpdate: true`, and it notices an
// update by the plugin's `version`, which every release bumps. Tags never
// move, so the marketplace is pinned to the `release` branch, which the
// publish workflow fast-forwards to each published tag.
//
// `connect` asks once, in a terminal, after pairing; `centrail setup-plugin`
// asks again. On yes: Claude Code's own commands add the marketplace and
// install the plugin (both no-ops when already done), then the settings
// entry gets `autoUpdate`, and a Stop hook `install-hooks` wrote is removed
// so the two never both run. Without a terminal it never asks and never
// writes; on no, or without `claude`, it prints the steps.

export const MARKETPLACE = "centrail"; // .claude-plugin/marketplace.json `name`
export const MARKETPLACE_REPO = "braydenyancy/centrail-cli";
export const RELEASE_REF = "release";

export const PLUGIN_STEPS = `
  Claude Code can run centrail after every turn through its plugin, kept current by Claude Code:
    claude plugin marketplace add ${MARKETPLACE_REPO}#${RELEASE_REF}
    claude plugin install ${PLUGIN_ID}
  then turn on its updates: /plugin → Marketplaces → ${MARKETPLACE} → Enable auto-update.`;

// Runs `claude <args>`; injected by tests, which never run the real one.
export type ClaudeRunner = (args: string[]) => Promise<{ code: number; output: string }>;

export type PluginSetupDeps = {
  settingsPath?: string;
  claude?: ClaudeRunner | null; // null: no `claude` on PATH
  ask?: (prompt: string) => Promise<string | null>; // null: input ended, no answer
};

export async function offerPlugin(
  opts: { interactive: boolean; again?: boolean },
  deps: PluginSetupDeps = {},
): Promise<void> {
  if ((await readConfig()).pluginAnswer && !opts.again) return; // asked once
  if (!opts.interactive) {
    console.log(PLUGIN_STEPS);
    return;
  }
  const claude = deps.claude === undefined ? await findClaude() : deps.claude;
  if (!claude) {
    // Not recorded: a `connect` after Claude Code is installed asks.
    console.log(PLUGIN_STEPS);
    return;
  }
  console.log("");
  const reply = await (deps.ask ?? askLine)("  Keep centrail's Claude Code plugin installed and updated automatically? [Y/n] ");
  if (reply === null) {
    // Input closed (Ctrl-D, a pipe that ran out): no answer is not a yes.
    console.log(PLUGIN_STEPS);
    return;
  }
  const answer = reply.trim().toLowerCase();
  const yes = answer === "" || answer.startsWith("y");
  await updateConfig((c) => {
    c.pluginAnswer = yes ? "yes" : "no";
  });
  if (!yes) {
    console.log(PLUGIN_STEPS);
    return;
  }
  await setUpPlugin(claude, deps.settingsPath ?? claudeSettingsPath());
}

async function setUpPlugin(claude: ClaudeRunner, path: string): Promise<boolean> {
  // The file must parse before anything touches it: `claude` rewrites it too.
  let file = await readOrSay(path);
  if (!file) return false;
  await backUpSettings(path); // before `claude` rewrites it too
  // Claude Code refuses to add a marketplace from a source other than the
  // one its settings entry names, and 0.6.1's README added this one at the
  // default branch. The entry is pointed at `release` first; the add below
  // then moves the marketplace there, and the plugin stays installed.
  const entry = marketplaceEntry(file.settings);
  if (entry && !isReleaseSource(entry.source)) {
    await writeSettingsFile(path, withMarketplace(file.settings, { ...entry, source: RELEASE_SOURCE }), file.indent);
  }
  console.log("  Setting up the Claude Code plugin…");
  for (const args of [
    ["plugin", "marketplace", "add", `${MARKETPLACE_REPO}#${RELEASE_REF}`, "--scope", "user"],
    ["plugin", "install", PLUGIN_ID, "--scope", "user"],
  ]) {
    const r = await claude(args);
    if (r.code !== 0) {
      const why = r.output.trim().split("\n").filter(Boolean).pop() ?? `exit ${r.code}`;
      console.log(`  ✗ \`claude ${args.join(" ")}\` failed: ${why}`);
      console.log("  Try again with `npx centrail setup-plugin`, or by hand:");
      console.log(PLUGIN_STEPS);
      return false;
    }
  }
  // After the add, which rewrites the entry and drops keys it does not set.
  file = await readOrSay(path);
  if (!file) return false;
  const withUpdates = withMarketplace(file.settings, { ...(marketplaceEntry(file.settings) ?? { source: RELEASE_SOURCE }), autoUpdate: true });
  const next = uninstallStopHook(withUpdates);
  const removedHook = JSON.stringify(next) !== JSON.stringify(withUpdates);
  await writeSettingsFile(path, next, file.indent);
  console.log("  ✓ Claude Code plugin installed. Claude Code updates it after each release (from its next launch);");
  console.log(`    to stop that: /plugin → Marketplaces → ${MARKETPLACE} → Disable auto-update.`);
  if (removedHook) console.log("  ✓ Removed the Stop hook `centrail install-hooks` wrote: the plugin's hook replaces it.");
  return true;
}

const RELEASE_SOURCE = { source: "github", repo: MARKETPLACE_REPO, ref: RELEASE_REF };

type MarketplaceEntry = Record<string, unknown> & { source?: unknown };

function marketplaceEntry(settings: Settings): MarketplaceEntry | undefined {
  const all = settings.extraKnownMarketplaces;
  const entry = isObject(all) ? all[MARKETPLACE] : undefined;
  return isObject(entry) ? entry : undefined;
}

function withMarketplace(settings: Settings, entry: MarketplaceEntry): Settings {
  const all = isObject(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {};
  return { ...settings, extraKnownMarketplaces: { ...all, [MARKETPLACE]: entry } };
}

function isReleaseSource(source: unknown): boolean {
  return isObject(source) && source.source === "github" && source.repo === MARKETPLACE_REPO && source.ref === RELEASE_REF;
}

async function readOrSay(path: string): Promise<{ settings: Settings; indent: string } | null> {
  try {
    return await readSettingsFile(path);
  } catch (err) {
    console.log(`  ${(err as Error).message}. Left it as it is; to set the plugin up by hand:`);
    console.log(PLUGIN_STEPS);
    return null;
  }
}

// `claude` on PATH, run without a shell except where Windows needs one for
// an npm-installed `claude.cmd` (the arguments are this file's constants).
async function findClaude(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeRunner | null> {
  const win = process.platform === "win32";
  const exts = win ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const bin = join(dir, `claude${ext}`);
      try {
        await access(bin, constants.X_OK);
      } catch {
        continue;
      }
      return (args) =>
        new Promise((resolve) => {
          execFile(win ? "claude" : bin, args, { shell: win, timeout: 180_000, windowsHide: true }, (err, stdout, stderr) => {
            const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
            resolve({ code, output: `${stdout}${stderr}` });
          });
        });
    }
  }
  return null;
}

// A line iterator, not rl.question(), as in `setup`: question() drops a line
// that arrives before it is asked, which piped or pasted input does. Input
// that already ended (the scope question met its end) answers nothing.
async function askLine(prompt: string): Promise<string | null> {
  process.stdout.write(prompt);
  if (process.stdin.readableEnded) {
    process.stdout.write("\n");
    return null;
  }
  const rl = createInterface({ input: process.stdin });
  try {
    const next = await rl[Symbol.asyncIterator]().next();
    if (next.done) process.stdout.write("\n");
    return next.done ? null : String(next.value);
  } finally {
    rl.close();
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
