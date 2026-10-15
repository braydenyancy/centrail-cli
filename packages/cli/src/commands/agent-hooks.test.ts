import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { piExtension, piExtensionLauncher } from "./agent-hooks.js";
import { commandWords, HOOK_SURFACES, isCentrailCommand, launcherCommand } from "./hooks-install.js";

const win = process.platform === "win32";
let roots: string[] = [];
afterEach(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
  roots = [];
});
const temp = async () => {
  const d = await mkdtemp(join(tmpdir(), "centrail-agent-hooks-"));
  roots.push(d);
  return d;
};

describe("entry commands", () => {
  const posix = "/home/u/.config/centrail/bin/centrail-hook";
  const windows = "C:\\Users\\u\\.config\\centrail\\bin\\centrail-hook.cmd";

  it.each(HOOK_SURFACES)("%s: the command written is recognised as centrail's on every platform and shell", (surface) => {
    for (const [path, platform] of [[posix, "linux"], [posix, "darwin"], [windows, "win32"]] as const) {
      for (const powershell of [false, true]) {
        const command = launcherCommand(path, surface, platform, { powershell });
        expect(isCentrailCommand(command)).toBe(true);
        expect(commandWords(command)?.[0]).toBe(path);
      }
    }
    expect(launcherCommand(windows, surface, "win32", { powershell: true })).toMatch(/^& "C:\\Users/);
    expect(launcherCommand(posix, surface, "linux", { powershell: true })).toMatch(/^"\/home/); // PowerShell only on Windows
  });

  it.each([
    ["another tool's PowerShell call", '& "C:\\tools\\other.cmd" hook stop'],
    ["an unknown surface", `"${posix}" hook stop --centrail-hook --surface cursor`],
    ["a launcher with extra arguments", `"${posix}" hook stop --centrail-hook --surface pi --verbose`],
    ["a relative launcher", "centrail-hook hook stop --centrail-hook --surface gemini-cli"],
    ["a compound command", `"${posix}" hook stop --centrail-hook --surface pi; rm -rf ~`],
  ])("never claims %s", (_, command) => {
    expect(isCentrailCommand(command)).toBe(false);
  });
});

describe("Pi extension", () => {
  it("names the launcher it runs, whatever the path holds; no other file is centrail's", () => {
    for (const path of ["/opt/a b/centrail-hook", 'C:\\Users\\O"Neil\\centrail-hook.cmd', "/home/ü/€/centrail-hook"]) {
      expect(piExtensionLauncher(piExtension(path))).toBe(path);
    }
    expect(piExtensionLauncher('const launcher = "/x/centrail-hook";\n')).toBeNull();
  });

  // The generated module, loaded as Pi loads it (a default export taking the
  // extension API), driven through agent_end with a recording launcher.
  it.skipIf(win)("at agent_end, starts the launcher detached with the session on stdin, and never throws", async () => {
    const dir = await temp();
    const record = join(dir, "record");
    const launcher = join(dir, "centrail-hook");
    await writeFile(launcher, `#!/bin/sh\n{ printf '%s\\n' "$@"; cat; } > "${record}.tmp" && mv "${record}.tmp" "${record}"\n`, { mode: 0o755 });
    const module = join(dir, "centrail.mjs"); // Pi loads .js through jiti; Node needs .mjs for ESM here
    await writeFile(module, piExtension(launcher));
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const ext = (await import(pathToFileURL(module).href)) as { default: (pi: unknown) => void };
    ext.default({ on: (event: string, handler: (e: unknown, c: unknown) => unknown) => void handlers.set(event, handler) });
    expect([...handlers.keys()]).toEqual(["agent_end"]);

    const agentEnd = handlers.get("agent_end")!;
    expect(() => agentEnd({ type: "agent_end", messages: [] }, { cwd: "/broken" })).not.toThrow(); // no sessionManager
    agentEnd({ type: "agent_end", messages: [] }, { cwd: "/work/repo", sessionManager: { getSessionId: () => "p1" } });
    let text = "";
    for (let i = 0; i < 100 && !text; i++) {
      text = await readFile(record, "utf-8").catch(() => "");
      if (!text) await new Promise((r) => setTimeout(r, 50));
    }
    const lines = text.split("\n");
    expect(lines.slice(0, 5)).toEqual(["hook", "stop", "--centrail-hook", "--surface", "pi"]);
    expect(JSON.parse(lines.slice(5).join("\n"))).toEqual({ hook_event_name: "agent_end", session_id: "p1", cwd: "/work/repo" });
  });
});

// The built CLI as each harness runs it: whatever the payload, it exits 0
// and prints exactly the reply that harness parses.
describe("hook stop through the built CLI", () => {
  const DIST = join(__dirname, "..", "..", "dist", "index.js");
  it.each([
    ["gemini-cli", "{}\n"],
    ["copilot-cli", "{}\n"],
    ["codex", "{}\n"],
    ["pi", ""],
    [null, ""],
  ])("--surface %s", async (surface, reply) => {
    const dir = await temp();
    const args = [DIST, "hook", "stop", "--centrail-hook", ...(surface ? ["--surface", surface] : [])];
    const r = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, args, { env: { ...process.env, CENTRAIL_CONFIG_DIR: dir }, windowsHide: true });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout }));
      child.stdin.end(JSON.stringify({ session_id: "s", sessionId: "s", cwd: join(dir, "gone") }));
    });
    expect(r).toEqual({ code: 0, stdout: reply });
  });
});
