import { spawn } from "node:child_process";
import { detectChannel, howToUpdate, type UpdateChannel } from "../update.js";
import { readLauncher, writeLauncher } from "../launcher.js";
import { askLine } from "./plugin-setup.js";
import { inspectIntegrations, type IntegrationDeps } from "./integrations.js";

// `centrail upgrade`: runs the one updater the running copy came from, with
// consent (decision B, 2026-10-07: the CLI never installs itself any other
// way). mise and a global npm prefix are updated in place; npx and the
// Claude Code plugin have their own updaters, so it says how instead.
// Afterwards the launcher is refreshed when one exists, so agent hooks run
// the updated copy.

export type UpgradeStep = { command: string[] | null; say: string };

export function upgradeStep(channel: UpdateChannel): UpgradeStep {
  switch (channel) {
    case "mise":
      return { command: ["mise", "upgrade", "npm:centrail"], say: "mise installed this copy." };
    case "npm-global":
      return { command: ["npm", "i", "-g", "centrail@latest"], say: "A global npm install is this copy." };
    case "npx":
      return { command: null, say: "npx runs the newest release whenever it is invoked as `npx centrail@latest`; there is nothing to install." };
    case "plugin":
      return { command: null, say: "This copy is the Claude Code plugin's: run `/plugin marketplace update centrail` in Claude Code (it also updates itself when auto-update is on)." };
    default:
      return { command: null, say: `Cannot tell how this copy was installed: ${howToUpdate(channel)}.` };
  }
}

export type UpgradeDeps = IntegrationDeps & {
  channel?: UpdateChannel;
  run?: (command: string[]) => Promise<number>; // exit code; tests never run a package manager
};

export async function runUpgrade(opts: { yes?: boolean; interactive?: boolean }, deps: UpgradeDeps = {}): Promise<{ ran: string[] | null; refreshed: boolean }> {
  const channel = deps.channel ?? detectChannel(deps.script);
  const step = upgradeStep(channel);
  console.log(step.say);
  let ran: string[] | null = null;
  if (step.command) {
    const shown = step.command.join(" ");
    if (!opts.yes) {
      if (!opts.interactive) {
        console.log(`Run \`${shown}\`, or \`centrail upgrade -y\` to let centrail run it.`);
        return { ran: null, refreshed: false };
      }
      const reply = (await (deps.ask ?? askLine)(`  Run \`${shown}\` now? [Y/n] `))?.trim().toLowerCase();
      if (reply === undefined || (reply !== "" && !reply.startsWith("y"))) {
        console.log("Nothing changed.");
        return { ran: null, refreshed: false };
      }
    }
    const code = await (deps.run ?? runInherit)(step.command);
    if (code !== 0) throw new Error(`\`${shown}\` exited with ${code}; nothing else changed.`);
    ran = step.command;
  } else if (channel !== "npx") {
    return { ran: null, refreshed: false };
  }
  const refreshed = await refreshLauncher(deps);
  if (refreshed) console.log("✓ Refreshed the hook launcher.");
  return { ran, refreshed };
}

// setup's launcher step on its own: only when a launcher already exists, so
// upgrading never installs an integration nobody asked for.
export async function refreshLauncher(deps: IntegrationDeps = {}): Promise<boolean> {
  const ins = await inspectIntegrations(deps);
  if ((await readLauncher(ins.launcher.path)) === null) return false;
  return writeLauncher(ins.expected, ins.launcher.path);
}

// Windows runs npm and mise shims through a shell (npm.cmd); the command is
// one of the constants above, never user input.
function runInherit(command: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { stdio: "inherit", shell: process.platform === "win32", windowsHide: true });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
