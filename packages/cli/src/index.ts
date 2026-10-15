#!/usr/bin/env node
import { runConnect } from "./commands/connect.js";
import { hookReply, runStopHook } from "./commands/hook.js";
import { HOOK_SURFACES } from "./commands/hooks-install.js";
import { runHooksDoctor } from "./commands/hooks-doctor.js";
import { runDoctor } from "./commands/doctor.js";
import { parseAgents, runIntegrationSetup, runUninstall } from "./commands/integrations.js";
import { runUpgrade } from "./commands/upgrade.js";
import { runImport } from "./commands/import.js";
import { runStatus } from "./commands/status.js";
import { CLI_VERSION } from "./version.js";
import { runSync } from "./commands/sync.js";
import { recordNode } from "./config.js";
import { progressDone, setProgressMode } from "./progress.js";
import { isInteractiveTerminal, runExclude, runInclude, runInspect, runRepos, runSetup as runScopeReview, runSurfaces } from "./commands/scope.js";

const [, , command, ...rest] = process.argv;

const flags = {
  url: undefined as string | undefined,
  full: false,
  last: false,
  noBrowser: false,
  json: false,
  yes: false,
  dryRun: false,
  fix: false,
  agents: [] as string[],
};
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--url") flags.url = rest[++i];
  else if (rest[i] === "--full") flags.full = true;
  else if (rest[i] === "--last") flags.last = true;
  else if (rest[i] === "--no-browser") flags.noBrowser = true;
  else if (rest[i] === "--json") flags.json = true;
  else if (rest[i] === "-y" || rest[i] === "--yes") flags.yes = true;
  else if (rest[i] === "--dry-run") flags.dryRun = true;
  else if (rest[i] === "--fix") flags.fix = true;
  else if (rest[i] === "--agent") flags.agents.push(rest[++i] ?? "");
  else if (rest[i] === "--quiet") setProgressMode("quiet");
  else if (rest[i] === "--verbose") setProgressMode("verbose");
}

const USAGE = `centrail — sync local AI agent usage to centrail.org

Usage:
  centrail connect [--url <base>]   Pair this machine with your account (opens your browser; --no-browser),
                                    then set up your agents
  centrail setup [--agent <name>] [-y] [--dry-run]
                                    Sync after every agent turn: Claude Code's plugin; a hook in Codex,
                                    Gemini CLI and Copilot CLI; an extension in Pi. Cursor and OpenCode
                                    (repo identity only, no usage yet) only when named
                                    (--agent claude-code|codex|gemini-cli|copilot-cli|pi|cursor|opencode;
                                    asks once unless -y)
  centrail doctor [--json] [--fix]  Check each agent's integration and centrail's version (read-only; --fix repairs)
  centrail uninstall [--agent <name>] [-y]
                                    Remove centrail's plugin, hooks and launcher
  centrail upgrade [-y]             Update this copy of centrail the way it was installed
  centrail status                   Which account this machine syncs to, and whether its pairing still works
  centrail --version                Print this copy's version
  centrail sync [--full]            Push new usage events (--full rescans everything)
                                    Progress shows in a terminal; --quiet hides it, --verbose forces it
  centrail inspect --last           Print the last attempted usage batch (not attribution)
  centrail scope                    Review which repos and folders sync (asked once at connect)
  centrail repos                    List them with status
  centrail exclude <repo>           Nothing about this repo leaves (host/owner/repo or folder name)
  centrail include <repo>           Undo an exclude; in allow mode, add it
  centrail surfaces [<name> on|off] Enable or disable a source (claude-code, codex, copilot-cli,
                                    gemini-cli, pi)
  centrail import <ccusage.json>    Import a ccusage "claude daily/session --json" file as Measured history
`;

// Old command names, kept for one release: a one-line pointer on stderr,
// then the new command.
const DEPRECATED: Record<string, string> = {
  "setup-plugin": "centrail setup --agent claude-code",
  "install-hooks": "centrail setup",
  "uninstall-hooks": "centrail uninstall",
  "doctor-hooks": "centrail doctor",
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

try {
  if (command && DEPRECATED[command]) {
    console.error(`centrail ${command} is deprecated and will be removed in the next release: use \`${DEPRECATED[command]}\`.`);
  }
  const interactive = isInteractiveTerminal();
  const agents = parseAgents(flags.agents.filter(Boolean));
  // A terminal knows where Node is; the plugin's hook, run by an app, may not.
  if (command !== "hook" && command !== "doctor" && command !== "doctor-hooks" && interactive) await recordNode();
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(`centrail ${CLI_VERSION}`);
  } else if (command === "connect") {
    await runConnect({ baseUrl: flags.url, noBrowser: flags.noBrowser });
  } else if (command === "status") {
    await runStatus();
  } else if (command === "sync") {
    await runSync({ full: flags.full });
  } else if (command === "setup") {
    await runIntegrationSetup({ agents, yes: flags.yes, dryRun: flags.dryRun, interactive });
  } else if (command === "setup-plugin") {
    await runIntegrationSetup({ agents: ["claude-code"], yes: flags.yes, dryRun: flags.dryRun, interactive });
  } else if (command === "install-hooks") {
    // It never asked before; scripts that ran it keep working.
    await runIntegrationSetup({ agents, yes: true, dryRun: flags.dryRun, interactive });
  } else if (command === "uninstall") {
    await runUninstall({ agents, yes: flags.yes, interactive });
  } else if (command === "uninstall-hooks") {
    // Its old scope: centrail's hooks only, never the plugin, without asking.
    await runUninstall({ agents, yes: true, interactive, keepPlugin: true });
  } else if (command === "doctor") {
    await runDoctor({ json: flags.json, fix: flags.fix, interactive });
  } else if (command === "doctor-hooks") {
    // --json keeps its version-1 report for tools that read it.
    if (flags.json) await runHooksDoctor(undefined, undefined, { json: true });
    else await runDoctor({ fix: flags.fix, interactive });
  } else if (command === "upgrade") {
    await runUpgrade({ yes: flags.yes, interactive });
  } else if (command === "inspect") {
    await runInspect();
  } else if (command === "hook") {
    // Shared processor, separate output contracts: each harness's entry
    // names itself with --surface (none: Claude Code's plugin) and gets the
    // stdout reply it expects (hookReply).
    const named = rest.includes("--surface") ? rest[rest.indexOf("--surface") + 1] : undefined;
    const surface = named && (HOOK_SURFACES as readonly string[]).includes(named) ? named : "claude-code";
    try {
      await runStopHook(await readStdin(), surface);
    } catch {
      // intentionally silent
    }
    process.stdout.write(hookReply(surface));
  } else if (command === "scope") {
    await runScopeReview({ interactive: true });
  } else if (command === "repos") {
    await runRepos();
  } else if (command === "exclude" || command === "include") {
    const name = rest[0];
    if (!name) {
      console.error(`Usage: centrail ${command} <repo>`);
      process.exit(1);
    }
    if (command === "exclude") await runExclude(name);
    else await runInclude(name);
  } else if (command === "import") {
    if (!rest[0]) {
      console.error("Usage: centrail import <ccusage.json>");
      process.exit(1);
    }
    await runImport(rest[0]);
  } else if (command === "surfaces") {
    await runSurfaces(rest);
  } else {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }
} catch (err) {
  progressDone(); // a status line mid-redraw would be drawn over the error
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
