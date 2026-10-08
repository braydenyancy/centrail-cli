// The Claude Code / Codex plugin: one hooks.json over the same bundle. The
// plugin carries its own copy of the CLI bundle (hash-pinned by the plugin
// version; never resolved from the network per turn), so the test runs
// THAT file as the harness would — a Stop input on stdin — and expects a
// sidecar line, nothing on stdout, exit 0.
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSidecar } from "./sidecar.js";
import { scratch, type Scratch } from "./testing/git-fixture.js";

const ROOT = join(__dirname, "..", "..", "..");
const PLUGIN = join(ROOT, "plugins", "centrail");
let fx: Scratch;
afterEach(async () => {
  await fx?.cleanup();
});

describe("plugins/centrail", () => {
  it("declares one Stop hook that runs the bundled CLI, and its version is the CLI's", async () => {
    const hooks = JSON.parse(await readFile(join(PLUGIN, "hooks", "hooks.json"), "utf-8"));
    const stop = hooks.hooks.Stop;
    expect(stop).toHaveLength(1);
    expect(stop[0].hooks).toEqual([{ type: "command", command: 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh"', timeout: 10 }]);
    expect(Object.keys(hooks.hooks)).toEqual(["Stop"]); // nothing else: no prompts read, no tools gated
    const plugin = JSON.parse(await readFile(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf-8"));
    const pkg = JSON.parse(await readFile(join(ROOT, "packages", "cli", "package.json"), "utf-8"));
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.name).toBe("centrail");
    const marketplace = JSON.parse(await readFile(join(ROOT, ".claude-plugin", "marketplace.json"), "utf-8"));
    expect(marketplace.plugins.map((p: { name: string; source: string }) => [p.name, p.source])).toEqual([["centrail", "./plugins/centrail"]]);
  });

  it("the bundled script is the current build, byte for byte", async () => {
    const bundled = await readFile(join(PLUGIN, "scripts", "centrail.mjs"));
    const built = await readFile(join(ROOT, "packages", "cli", "dist", "index.js"));
    expect(bundled.equals(built)).toBe(true);
  });

  it("runs as the harness runs it: Stop input on stdin → one sidecar line, silent, exit 0; garbage input → still exit 0", async () => {
    fx = await scratch();
    const repo = await fx.repo("r", { remote: "https://github.com/acme/r.git" });
    const cfg = await mkdtemp(join(tmpdir(), "centrail-plugin-"));
    const run = (input: string) => runHook(process.execPath, [join(PLUGIN, "scripts", "centrail.mjs"), "hook", "stop"], cfg, input);
    const { stdout, stderr, code } = await run(JSON.stringify({ session_id: "s-plugin", cwd: repo, hook_event_name: "Stop", stop_hook_active: false }));
    expect([stdout, stderr, code]).toEqual(["", "", 0]);
    const lines = await readSidecar(join(cfg, "sessions.jsonl"));
    expect(lines.get("s-plugin")?.repo?.key).toBe("github.com/acme/r");
    expect(await run("not json")).toEqual({ stdout: "", stderr: "", code: 0 });
    await rm(cfg, { recursive: true, force: true });
  });

  // Claude Code runs a hook's command string with `sh -c` on macOS and
  // Linux and with Git Bash on Windows (code.claude.com/docs/en/hooks), and
  // hands it CLAUDE_PLUGIN_ROOT with forward slashes. This runs hooks.json's
  // own string that way, so a quoting or path assumption fails on the OS it
  // fails on — and the folder it records must be the folder the agent was in.
  it("runs hooks.json's command through the shell Claude Code uses, and records the agent's own folder", async () => {
    fx = await scratch();
    const repo = await fx.repo("r", { remote: "https://github.com/acme/r.git" });
    const cfg = await mkdtemp(join(tmpdir(), "centrail-plugin-"));
    const hooks = JSON.parse(await readFile(join(PLUGIN, "hooks", "hooks.json"), "utf-8"));
    const command: string = hooks.hooks.Stop[0].hooks[0].command;
    const input = JSON.stringify({ session_id: "s-shell", cwd: repo, hook_event_name: "Stop", stop_hook_active: false });
    expect(await runHook(hookShell(), ["-c", command], cfg, input)).toEqual({ stdout: "", stderr: "", code: 0 });
    const line = (await readSidecar(join(cfg, "sessions.jsonl"))).get("s-shell");
    expect(line?.repo?.key).toBe("github.com/acme/r");
    expect(line?.root).toBe(repo);
    await rm(cfg, { recursive: true, force: true });
  });

  // Claude Code started from the Dock or an IDE may have a PATH with no Node
  // on it. The launcher must still find one: here a PATH holding only `sh`
  // and `git`, and the Node a terminal recorded, wrapped so the test can see
  // it was that one.
  it.skipIf(process.platform === "win32")("finds the Node a terminal recorded when the app's PATH has none", async () => {
    fx = await scratch();
    const repo = await fx.repo("r", { remote: "https://github.com/acme/r.git" });
    const cfg = await mkdtemp(join(tmpdir(), "centrail-plugin-"));
    const bin = await bareBin(cfg);
    const wrapper = join(cfg, "recorded-node");
    await writeFile(wrapper, `#!/bin/sh\n: > "${join(cfg, "used-recorded")}"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
    await writeFile(join(cfg, "node"), `${wrapper}\n`);
    const input = JSON.stringify({ session_id: "s-recorded", cwd: repo, hook_event_name: "Stop" });
    expect(await runHook("/bin/sh", ["-c", await hookCommand()], cfg, input, { PATH: bin, HOME: join(cfg, "home") })).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(existsSync(join(cfg, "used-recorded"))).toBe(true);
    expect((await readSidecar(join(cfg, "sessions.jsonl"))).get("s-recorded")?.repo?.key).toBe("github.com/acme/r");
    await rm(cfg, { recursive: true, force: true });
  });

  // Where a fixed install spot holds a Node (CI images do) there is no
  // machine without one to test against.
  const spots = ["/opt/homebrew/bin/node", "/usr/local/bin/node"];
  it.skipIf(process.platform === "win32" || spots.some((p) => existsSync(p)))("with no Node anywhere, says so in one line instead of failing silently", async () => {
    const cfg = await mkdtemp(join(tmpdir(), "centrail-plugin-"));
    const bin = await bareBin(cfg);
    const { stdout, stderr, code } = await runHook("/bin/sh", ["-c", await hookCommand()], cfg, "{}", { PATH: bin, HOME: join(cfg, "home") });
    expect([stdout, code]).toEqual(["", 1]);
    expect(stderr.trim().split("\n")).toEqual([expect.stringMatching(/^centrail: no Node\.js found .*npx centrail setup-plugin/)]);
    await rm(cfg, { recursive: true, force: true });
  });
});

async function hookCommand(): Promise<string> {
  const hooks = JSON.parse(await readFile(join(PLUGIN, "hooks", "hooks.json"), "utf-8"));
  return hooks.hooks.Stop[0].hooks[0].command;
}

// A PATH directory with only `sh` and `git`: what an app-launched Claude
// Code without a Node on its PATH can still run.
async function bareBin(dir: string): Promise<string> {
  const bin = join(dir, "bin");
  await mkdir(bin);
  for (const tool of ["sh", "git"]) {
    const found = execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).trim();
    await symlink(found, join(bin, tool));
  }
  return bin;
}

function hookShell(): string {
  if (process.platform !== "win32") return "sh";
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  return existsSync(gitBash) ? gitBash : "bash";
}

function runHook(cmd: string, args: string[], cfg: string, input: string, extra: NodeJS.ProcessEnv = {}) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const env = { ...process.env, ...extra, CENTRAIL_CONFIG_DIR: cfg, CLAUDE_PLUGIN_ROOT: PLUGIN.replaceAll("\\", "/") };
    const child = spawn(cmd, args, { env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}
