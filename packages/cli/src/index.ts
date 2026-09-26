#!/usr/bin/env node
import { runConnect } from "./commands/connect.js";
import { runStopHook } from "./commands/hook.js";
import { runInstallHooks } from "./commands/hooks-install.js";
import { runSync } from "./commands/sync.js";
import { addDenyRepo, readLastSync } from "./config.js";

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
  centrail exclude <repo>           Stop attributing a repo (host/owner/repo or folder name)
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
  } else if (command === "exclude") {
    const name = rest[0];
    if (!name) {
      console.error("Usage: centrail exclude <repo>");
      process.exit(1);
    }
    await addDenyRepo(name);
    console.log(`Excluded "${name}" — its commits won't be attributed.`);
  } else {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
