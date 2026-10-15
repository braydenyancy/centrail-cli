import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launcherPath, launcherScript, launcherScriptPath, launcherTarget, NODE_DISCOVERY_SH, stableScript, writeLauncher } from "./launcher.js";

// The stable launcher: generated text, then the POSIX script executed for
// real in a scratch HOME with fake node/centrail/npx that record what they
// were given. No test runs a package manager or a real centrail install.
const ROOT = join(__dirname, "..", "..", "..");
let dir: string;
beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), "centrail-launcher-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("launcher text", () => {
  const target = { script: "/opt/node/lib/node_modules/centrail/dist/index.js", node: "/opt/node/bin/node", major: "0" };

  it("tries the stable install, then centrail on PATH, then npx at the same major, in that order", () => {
    const sh = launcherScript(target, "linux");
    expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh).toContain("script='/opt/node/lib/node_modules/centrail/dist/index.js'");
    const order = ['exec "$node" "$script" "$@"', 'exec "$cli" "$@"', 'exec "$npx" -y centrail@0 "$@"'].map((s) => sh.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(launcherScriptPath(sh)).toBe(target.script);
  });

  it("shares its Node discovery verbatim with the Claude Code plugin's hook.sh", async () => {
    expect(launcherScript(target, "linux")).toContain(NODE_DISCOVERY_SH);
    expect(await readFile(join(ROOT, "plugins", "centrail", "scripts", "hook.sh"), "utf-8")).toContain(NODE_DISCOVERY_SH);
  });

  it("quotes any path it embeds, and refuses one it cannot", () => {
    const odd = "/tmp/it's $HOME `x`/index.js";
    expect(launcherScriptPath(launcherScript({ ...target, script: odd }, "linux"))).toBe(odd);
    expect(() => launcherScript({ ...target, script: "/a\nb" }, "linux")).toThrow(/newline/);
    expect(() => launcherScript({ ...target, script: "C:\\100%\\x.js" }, "win32")).toThrow(/percent/);
  });

  it("writes a cmd.exe launcher on Windows with the same order", () => {
    const cmd = launcherScript({ script: "C:\\Users\\j\\AppData\\Roaming\\npm\\node_modules\\centrail\\dist\\index.js", node: "C:\\Program Files\\nodejs\\node.exe", major: "0" }, "win32");
    expect(cmd.startsWith("@echo off\r\n")).toBe(true);
    expect(cmd).not.toMatch(/[^\r]\n/); // CRLF throughout
    const order = ['"%node%" "%script%" %*', 'call "%cli%" %*', 'call "%npx%" -y centrail@0 %*'].map((s) => cmd.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(launcherScriptPath(cmd)).toBe("C:\\Users\\j\\AppData\\Roaming\\npm\\node_modules\\centrail\\dist\\index.js");
    expect(launcherPath("C:\\cfg", "win32").endsWith("centrail-hook.cmd")).toBe(true);
  });
});

describe("launcherTarget: only a stable install is written in", () => {
  it.each([
    ["an npx cache", "/home/u/.npm/_npx/0a1b/node_modules/centrail/dist/index.js", null],
    ["the Claude Code plugin cache", "/home/u/.claude/plugins/cache/centrail/centrail/0.8.1/scripts/centrail.mjs", null],
    ["a checkout", "/home/u/src/centrail-cli/packages/cli/dist/index.js", null],
    ["a global npm prefix", "/usr/local/lib/node_modules/centrail/dist/index.js", "/usr/local/lib/node_modules/centrail/dist/index.js"],
  ])("%s", (_, script, expected) => {
    expect(stableScript(script, {})).toBe(expected);
  });

  it("follows mise's alias, and never pins npx's own Node", async () => {
    const installs = join(dir, "installs", "npm-centrail");
    mkdirSync(join(installs, "0.8.1", "lib", "node_modules", "centrail", "dist"), { recursive: true });
    const real = join(installs, "0.8.1", "lib", "node_modules", "centrail", "dist", "index.js");
    await writeFile(real, "");
    symlinkSync(join(installs, "0.8.1"), join(installs, "latest"), "junction");
    expect(stableScript(real, {})).toBe(join(installs, "latest", "lib", "node_modules", "centrail", "dist", "index.js"));
    expect(launcherTarget("/x/_npx/1/node_modules/centrail/dist/index.js", "/x/_npx/1/node", null, {}).node).toBeNull();
  });

  it("an unstable copy keeps the stable install an earlier setup recorded", () => {
    const previous = "/usr/local/lib/node_modules/centrail/dist/index.js";
    expect(launcherTarget("/home/u/.npm/_npx/9/node_modules/centrail/dist/index.js", "/usr/bin/node", previous, {}).script).toBe(previous);
  });

  it("is written atomically, executable, and only when it changes", async () => {
    const path = launcherPath(dir, process.platform);
    const text = launcherScript({ script: null, node: null, major: "0" });
    expect(await writeLauncher(text, path)).toBe(true);
    expect(await writeLauncher(text, path)).toBe(false);
    expect(await readFile(path, "utf-8")).toBe(text);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o755);
  });
});

// Builtins only: the launcher runs with a PATH holding just the fakes.
describe.skipIf(process.platform === "win32")("the POSIX launcher, executed", () => {
  const spots = ["/opt/homebrew/bin/node", "/usr/local/bin/node"];

  // A fake that records its argv and stdin, then exits 0. `cat` by its
  // absolute path: the PATH under test holds only the fakes.
  const cat = process.platform === "win32" ? "" : execFileSync("/bin/sh", ["-c", "command -v cat"], { encoding: "utf-8" }).trim();
  async function fake(path: string, name: string) {
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "${name}" "$@" > "${dir}/argv"\n"${cat}" > "${dir}/stdin"\n`, { mode: 0o755 });
  }

  async function run(target: { script: string | null; node: string | null }, bin: string) {
    const path = launcherPath(join(dir, "cfg"));
    await writeLauncher(launcherScript({ ...target, major: "0" }, "linux"), path);
    return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const env = { PATH: bin, HOME: join(dir, "home"), NVM_DIR: join(dir, "nvm"), CENTRAIL_CONFIG_DIR: join(dir, "cfg") };
      const child = spawn(path, ["hook", "stop", "--centrail-hook", "--surface", "codex"], { env });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
      child.stdin.on("error", () => {});
      child.stdin.end('{"session_id":"s1"}');
    });
  }

  async function bin() {
    const b = join(dir, "bin");
    await mkdir(b, { recursive: true });
    return b;
  }
  const argv = async () => (await readFile(join(dir, "argv"), "utf-8")).trim().split("\n");

  it("runs the stable install with the Node it finds, passing arguments and stdin through", async () => {
    const b = await bin();
    await fake(join(b, "node"), "node");
    const script = join(dir, "index.js");
    await writeFile(script, "");
    expect(await run({ script, node: null }, b)).toEqual({ code: 0, stderr: "" });
    expect(await argv()).toEqual(["node", script, "hook", "stop", "--centrail-hook", "--surface", "codex"]);
    expect(await readFile(join(dir, "stdin"), "utf-8")).toBe('{"session_id":"s1"}');
  });

  // A fixed install spot (CI images have one) would be found first.
  it.skipIf(spots.some((p) => existsSync(p)))("falls back to the Node setup ran with when nothing else has one", async () => {
    const pinned = join(dir, "pinned-node");
    await fake(pinned, "pinned");
    const script = join(dir, "index.js");
    await writeFile(script, "");
    expect((await run({ script, node: pinned }, await bin())).code).toBe(0);
    expect((await argv())[0]).toBe("pinned");
  });

  it("with the stable install gone, runs `centrail` from PATH", async () => {
    const b = await bin();
    await fake(join(b, "centrail"), "centrail");
    expect((await run({ script: join(dir, "pruned", "index.js"), node: null }, b)).code).toBe(0);
    expect(await argv()).toEqual(["centrail", "hook", "stop", "--centrail-hook", "--surface", "codex"]);
    expect(await readFile(join(dir, "stdin"), "utf-8")).toBe('{"session_id":"s1"}');
  });

  it("with no centrail anywhere, runs npx at the launcher's major", async () => {
    const b = await bin();
    await fake(join(b, "npx"), "npx");
    expect((await run({ script: null, node: null }, b)).code).toBe(0);
    expect(await argv()).toEqual(["npx", "-y", "centrail@0", "hook", "stop", "--centrail-hook", "--surface", "codex"]);
  });

  it.skipIf(spots.some((p) => existsSync(p)))("with nothing to run, says so in one line and exits 1", async () => {
    const { code, stderr } = await run({ script: null, node: null }, await bin());
    expect(code).toBe(1);
    expect(stderr.trim().split("\n")).toEqual([expect.stringMatching(/^centrail: no centrail CLI or Node\.js found .*npx centrail setup/)]);
  });
});
