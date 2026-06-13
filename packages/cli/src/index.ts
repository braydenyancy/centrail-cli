#!/usr/bin/env node
import { runConnect } from "./commands/connect.js";
import { runSync } from "./commands/sync.js";
import { addDenyRepo } from "./config.js";

const [, , command, ...rest] = process.argv;

const flags = { url: undefined as string | undefined, full: false };
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--url") flags.url = rest[++i];
  else if (rest[i] === "--full") flags.full = true;
}

const USAGE = `centrail — sync local AI agent usage to centrail.org

Usage:
  centrail connect [--url <base>]   Pair this machine with your account
  centrail sync [--full]            Push new usage events (--full rescans everything)
  centrail exclude <repo>           Stop attributing commits for a repo (by name)
`;

try {
  if (command === "connect") {
    await runConnect({ baseUrl: flags.url });
  } else if (command === "sync") {
    await runSync({ full: flags.full });
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
