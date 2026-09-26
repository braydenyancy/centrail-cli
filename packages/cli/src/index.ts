#!/usr/bin/env node
import { runConnect } from "./commands/connect.js";
import { runStopHook } from "./commands/hook.js";
import { runInstallHooks } from "./commands/hooks-install.js";
import { runSync } from "./commands/sync.js";
import { readLastSync } from "./config.js";
import { runExclude, runInclude, runRepos, runSetup, runSurfaces } from "./commands/scope.js";

const [, , command, ...rest] = process.argv;

const flags = { url: undefined as string | undefined, full: false, last: false };
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--url") flags.url = rest[++i];
  else if (rest[i] === "--full") flags.full = true;
  else if (rest[i] === "--last") flags.last = true;
}

const USAGE = `centrail — sync local AI agent usage to centrail.org

Usage:
  centrail connect [--url <base>]   Pair this machine with your account
  centrail sync [--full]            Push new usage events (--full rescans everything)
  centrail install-hooks            Auto-sync: add the Stop hook to Claude Code's settings
  centrail uninstall-hooks          Remove that hook
  centrail inspect --last           Print the last payload exactly as it left this machine
  centrail setup                    Review which repos and folders sync (asked once at connect)
  centrail repos                    List them with status
  centrail exclude <repo>           Nothing about this repo leaves (host/owner/repo or folder name)
  centrail include <repo>           Undo an exclude; in allow mode, add it
  centrail surfaces [<name> on|off] Enable or disable a source (claude-code, codex, copilot-cli)
  centrail hook stop                (run by the agent's Stop hook; reads JSON on stdin)
`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

try {
  if (command === "connect") {
    await runConnect({ baseUrl: flags.url });
  } else if (command === "sync") {
    await runSync({ full: flags.full });
  } else if (command === "install-hooks") {
    await runInstallHooks({ remove: false });
  } else if (command === "uninstall-hooks") {
    await runInstallHooks({ remove: true });
  } else if (command === "inspect") {
    const last = await readLastSync();
    console.log(last ?? "No sync has run on this machine yet.");
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
  } else if (command === "surfaces") {
    await runSurfaces(rest);
  } else {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
