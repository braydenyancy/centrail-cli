import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const flags = new Set(process.argv.slice(2));
for (const flag of flags) {
  if (!["--comparisons", "--comparisons-setup", "--codex-discovery"].includes(flag)) {
    throw new Error(`Unknown verification option: ${flag}`);
  }
}
// npm supplies its JS entrypoint. Calling it with this Node executable also
// works on native Windows without spawning npm.cmd through a shell.
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this suite with npm run verify.");
if (flags.has("--codex-discovery") && !process.env.CENTRAIL_CODEX_BIN) {
  throw new Error("--codex-discovery requires CENTRAIL_CODEX_BIN pointing to a local executable.");
}

function run(label, args) {
  console.log(`\nVerification: ${label}`);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

for (const script of ["build", "typecheck", "test", "test:server-contract", "test:release", "release:pack", "test:comparison-gate"]) {
  run(script, [npm, "run", script]);
}
if (flags.has("--comparisons-setup")) {
  console.log("\nVerification: explicit pinned comparison provisioning (downloads tools)");
  const result = spawnSync(process.env.CENTRAIL_COMPARISON_PYTHON ?? "python3.12", [
    join(root, "tools", "tokscale-compare", "provision.py"),
  ], { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (flags.has("--comparisons") || flags.has("--comparisons-setup")) {
  run("offline parser comparisons", [npm, "run", "test:comparisons"]);
}
if (flags.has("--codex-discovery")) {
  run("scratch Codex hook discovery", [join(root, "scripts", "check-codex-hook-discovery.mjs")]);
}
console.log("\nVerification passed. Optional comparison/runtime checks ran only when explicitly selected.");
