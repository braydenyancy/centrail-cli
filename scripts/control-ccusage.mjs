#!/usr/bin/env node
// Compatibility entrypoint for the pinned, fixture-only comparison suite.
// No implicit personal-log scanning or package downloads.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const suite = fileURLToPath(new URL("../tools/tokscale-compare/suite.py", import.meta.url));
const result = spawnSync("python3", [suite, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
