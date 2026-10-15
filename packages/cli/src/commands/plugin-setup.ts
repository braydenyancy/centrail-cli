import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import { createInterface } from "node:readline/promises";
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
// `centrail setup` (integrations.ts) calls setUpPlugin: Claude Code's own
// commands add the marketplace and install the plugin (both no-ops when
// already done), then the settings entry gets `autoUpdate`, and a
// standalone centrail Stop hook is removed so the two never both run.

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

export async function setUpPlugin(claude: ClaudeRunner, path: string): Promise<boolean> {
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
      console.log("  Try again with `centrail setup`, or by hand:");
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
  if (removedHook) console.log("  ✓ Removed the standalone centrail Stop hook: the plugin's hook replaces it.");
  // Claude Code loads a plugin when a session starts; one already open runs
  // without it (and without the hook just removed) until it reloads.
  console.log("  Claude Code sessions already open: run /reload-plugins in each, or restart them, so their turns are recorded.");
  return true;
}

export const RELEASE_SOURCE = { source: "github", repo: MARKETPLACE_REPO, ref: RELEASE_REF };

export type MarketplaceEntry = Record<string, unknown> & { source?: unknown };

export function marketplaceEntry(settings: Settings): MarketplaceEntry | undefined {
  const all = settings.extraKnownMarketplaces;
  const entry = isObject(all) ? all[MARKETPLACE] : undefined;
  return isObject(entry) ? entry : undefined;
}

export function withMarketplace(settings: Settings, entry: MarketplaceEntry): Settings {
  const all = isObject(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {};
  return { ...settings, extraKnownMarketplaces: { ...all, [MARKETPLACE]: entry } };
}

export function isReleaseSource(source: unknown): boolean {
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

// An executable on PATH (with PATHEXT on Windows), or null.
export async function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const win = platform === "win32";
  const exts = win ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(win ? ";" : delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const bin = join(dir, `${name}${ext}`);
      try {
        await access(bin, win ? constants.F_OK : constants.X_OK);
        return bin;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

// Runs a found executable without a shell, except where Windows needs one
// for an npm-installed `.cmd`, where it runs the name from PATH (the
// arguments are this CLI's constants).
export function runnerFor(bin: string, platform: NodeJS.Platform = process.platform): ClaudeRunner {
  const win = platform === "win32";
  return (args) =>
    new Promise((resolve) => {
      execFile(win ? basename(bin).replace(/\.(?:cmd|exe|bat)$/i, "") : bin, args, { shell: win, timeout: 180_000, windowsHide: true }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, output: `${stdout}${stderr}` });
      });
    });
}

// A line iterator, not rl.question(), as in the scope review: question()
// drops a line that arrives before it is asked, which piped or pasted input
// does. Input that already ended (the scope question met its end) answers nothing.
export async function askLine(prompt: string): Promise<string | null> {
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
