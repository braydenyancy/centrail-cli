// Optional real-runtime receipt: no model turn, user home or network is needed.
// Build first, then CENTRAIL_CODEX_BIN=/absolute/codex node scripts/check-codex-hook-discovery.mjs.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const binary = process.env.CENTRAIL_CODEX_BIN;
if (!binary) throw new Error("Set CENTRAIL_CODEX_BIN to a local Codex executable.");
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "centrail-codex-discovery-"));
const home = join(root, "home");
const market = join(root, "market");
const plugin = join(market, "plugins", "centrail");
const config = join(root, "centrail-config");
// Deliberately omit all provider credentials and both plugin-root variables.
// Windows still needs SystemRoot and COMSPEC for native process startup.
const env = {
  HOME: home, USERPROFILE: home, CODEX_HOME: home, CENTRAIL_CONFIG_DIR: config,
  PATH: process.env.PATH ?? "", SHELL: "/bin/sh",
  ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec ?? process.env.COMSPEC } : {}),
};

function cli(args) {
  const result = spawnSync(binary, args, { cwd: root, env, encoding: "utf-8", timeout: 20_000, windowsHide: true });
  assert.equal(result.status, 0, "scratch Codex setup failed");
  return JSON.parse(result.stdout);
}

async function inventory() {
  const child = spawn(binary, ["app-server", "--stdio"], { cwd: root, env, windowsHide: true });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const pending = new Map();
  const rejectPending = () => {
    for (const callback of pending.values()) callback({ error: true });
  };
  child.on("error", rejectPending);
  child.on("exit", rejectPending);
  let buffered = "";
  child.stderr.resume(); // only this scratch runtime; never print path-bearing diagnostics
  child.stdout.on("data", (data) => {
    buffered += data;
    while (buffered.includes("\n")) {
      const end = buffered.indexOf("\n");
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      pending.get(message.id)?.(message);
    }
  });
  const ask = (id, method, params) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Scratch Codex ${method} timed out`)), 15_000);
    pending.set(id, (message) => {
      clearTimeout(timeout); pending.delete(id);
      if (message.error) reject(new Error(`Scratch Codex ${method} failed`));
      else resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await ask(1, "initialize", { clientInfo: { name: "centrail-hook-fixture", version: "0.0.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized"}\n');
    const result = await ask(2, "hooks/list", { cwds: [root] });
    assert.equal(result.data[0].errors.length, 0);
    return result.data[0].hooks.filter((hook) => hook.eventName === "stop");
  } finally {
    child.kill("SIGKILL"); // this disposable app-server may wait for shutdown tasks on SIGTERM
    await closed;
  }
}

async function dispatch(hooks, session) {
  const input = JSON.stringify({ session_id: session, turn_id: "fixture-turn", cwd: root, hook_event_name: "Stop", stop_hook_active: false });
  for (const hook of hooks) {
    const windows = process.platform === "win32";
    const shell = windows ? env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe" : "/bin/sh";
    const args = windows ? ["/d", "/s", "/c", `"${hook.command}"`] : ["-c", hook.command];
    const result = spawnSync(shell, args, { cwd: root, env, input, encoding: "utf-8", windowsVerbatimArguments: windows, timeout: 10_000 });
    assert.equal(result.status, 0, "discovered fixture hook did not launch");
    assert.equal(result.stderr, "");
  }
  const rows = (await readFile(join(config, "sessions.jsonl"), "utf-8")).trim().split("\n").map(JSON.parse);
  return rows.filter((row) => row.sessionId === session);
}

try {
  await mkdir(home, { recursive: true });
  await mkdir(join(market, ".claude-plugin"), { recursive: true });
  await cp(join(repo, "plugins", "centrail"), plugin, { recursive: true });
  // Control models the released plugin before the Codex override was added.
  await rm(join(plugin, ".codex-plugin"), { recursive: true, force: true });
  const manifestPath = join(plugin, ".claude-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: "0.7.3" }));
  await writeFile(join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "fixture", owner: { name: "Fixture" }, plugins: [{ name: "centrail", source: "./plugins/centrail", description: "fixture" }] }));
  const quote = (path) => `"${process.platform === "win32" ? path : path.replace(/[\\"$`]/g, "\\$&")}"`;
  const command = `${quote(process.execPath)} ${quote(join(repo, "packages", "cli", "dist", "index.js"))} hook stop --centrail-hook --surface codex`;
  await writeFile(join(home, "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command, timeout: 10 }] }] } }));
  cli(["plugin", "marketplace", "add", market, "--json"]);
  cli(["plugin", "add", "centrail@fixture", "--json"]);
  const before = await inventory();
  assert.equal(before.length, 2);
  assert.equal(before.filter((hook) => hook.source === "plugin").length, 1);
  // Native Windows Codex has no Unix launcher requirement; the old plugin
  // cannot be dispatched there without Git Bash. Inventory still proves duplication.
  if (process.platform !== "win32") assert.equal((await dispatch(before, "fixture-before")).length, 2);

  await cp(join(repo, "plugins", "centrail"), plugin, { recursive: true });
  cli(["plugin", "add", "centrail@fixture", "--json"]);
  const after = await inventory();
  assert.equal(after.length, 1);
  assert.equal(after[0].source, "user");
  assert.equal(after[0].command, command);
  assert.equal((await dispatch(after, "fixture-after")).length, 1);
  console.log("Codex discovery receipt: legacy plugin registration + explicit hook = 2 Stop handlers; current overlay + explicit hook = 1; fixture dispatch records once.");
} finally {
  await rm(root, { recursive: true, force: true });
}
