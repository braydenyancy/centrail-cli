#!/usr/bin/env node
import { runConnect } from "./commands/connect.js";
import { runStopHook } from "./commands/hook.js";
import { runInstallHooks } from "./commands/hooks-install.js";
import { offerPlugin } from "./commands/plugin-setup.js";
import { runImport } from "./commands/import.js";
import { runStatus } from "./commands/status.js";
import { runSync } from "./commands/sync.js";
import { progressDone, setProgressMode } from "./progress.js";
import { isInteractiveTerminal, runExclude, runInclude, runInspect, runRepos, runSetup, runSurfaces } from "./commands/scope.js";

const [, , command, ...rest] = process.argv;

const flags = { url: undefined as string | undefined, full: false, last: false, noBrowser: false };
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--url") flags.url = rest[++i];
  else if (rest[i] === "--full") flags.full = true;
  else if (rest[i] === "--last") flags.last = true;
  else if (rest[i] === "--no-browser") flags.noBrowser = true;
  else if (rest[i] === "--quiet") setProgressMode("quiet");
  else if (rest[i] === "--verbose") setProgressMode("verbose");
}

const USAGE = `centrail — sync local AI agent usage to centrail.org

Usage:
  centrail connect [--url <base>]   Pair this machine with your account (opens your browser; --no-browser)
  centrail status                   Which account this machine syncs to, and whether its pairing still works
  centrail sync [--full]            Push new usage events (--full rescans everything)
                                    Progress shows in a terminal; --quiet hides it, --verbose forces it
  centrail setup-plugin             Auto-sync in Claude Code: install its plugin and let Claude Code update it (asked at connect)
  centrail install-hooks            Auto-sync without the plugin: a Stop hook for Codex (and Claude Code)
  centrail uninstall-hooks          Remove that hook
  centrail inspect --last           Print the last payload exactly as it left this machine
  centrail setup                    Review which repos and folders sync (asked once at connect)
  centrail repos                    List them with status
  centrail exclude <repo>           Nothing about this repo leaves (host/owner/repo or folder name)
  centrail include <repo>           Undo an exclude; in allow mode, add it
  centrail surfaces [<name> on|off] Enable or disable a source (claude-code, codex, copilot-cli)
  centrail import <ccusage.json>    Import a ccusage "claude daily/session --json" file as Measured history
  centrail hook stop                (run by the agent's Stop hook; reads JSON on stdin)
`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

try {
  if (command === "connect") {
    await runConnect({ baseUrl: flags.url, noBrowser: flags.noBrowser });
  } else if (command === "status") {
    await runStatus();
  } else if (command === "sync") {
    await runSync({ full: flags.full });
  } else if (command === "setup-plugin") {
    await offerPlugin({ interactive: isInteractiveTerminal(), again: true });
  } else if (command === "install-hooks") {
    await runInstallHooks({ remove: false });
  } else if (command === "uninstall-hooks") {
    await runInstallHooks({ remove: true });
  } else if (command === "inspect") {
    await runInspect();
  } else if (command === "hook") {
    // Never fail the agent's turn: any error is swallowed, nothing is printed.
    try {
      await runStopHook(await readStdin(), "claude-code");
    } catch {
      // intentionally silent
    }
  } else if (command === "setup") {
    await runSetup({ interactive: true });
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
