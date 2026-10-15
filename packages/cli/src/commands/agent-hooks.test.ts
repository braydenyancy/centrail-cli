import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { moduleLauncher, OPENCODE_PLUGIN_MARK, opencodePlugin, piExtension, piExtensionLauncher } from "./agent-hooks.js";
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
    ["an unknown surface", `"${posix}" hook stop --centrail-hook --surface windsurf`],
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
    // The mark counts only in the header line: a user's file that mentions it is not centrail's.
    expect(piExtensionLauncher('// mine\n// centrail-pi-extension\nconst launcher = "/x/centrail-hook";\n')).toBeNull();
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

// The generated plugin, loaded as OpenCode v1 loads a local plugin (every
// export is a plugin function given { client, directory, … } and returning
// hooks), driven through its event hook with a fake SDK client.
describe("OpenCode plugin", () => {
  it("names the launcher it runs; only its own header makes a file centrail's", () => {
    for (const path of ["/opt/a b/centrail-hook", 'C:\\Users\\O"Neil\\centrail-hook.cmd']) {
      expect(moduleLauncher(opencodePlugin(path), OPENCODE_PLUGIN_MARK)).toBe(path);
    }
    expect(moduleLauncher(piExtension("/x/centrail-hook"), OPENCODE_PLUGIN_MARK)).toBeNull();
  });

  it.skipIf(win)("on idle, starts the launcher with the top-level session's id and folder; skips subagents and repeats; never throws", async () => {
    const dir = await temp();
    const records = join(dir, "records");
    await mkdir(records);
    const launcher = join(dir, "centrail-hook");
    // One file per run: args, then stdin.
    await writeFile(launcher, `#!/bin/sh\n{ printf '%s\\n' "$@"; cat; } > "${records}/.$$" && mv "${records}/.$$" "${records}/run-$$"\n`, { mode: 0o755 });
    const module = join(dir, "centrail.mjs");
    await writeFile(module, opencodePlugin(launcher));
    const exports = (await import(pathToFileURL(module).href)) as Record<string, unknown>;
    // Every export must be a plugin function, or OpenCode skips the file.
    expect(Object.values(exports).every((v) => typeof v === "function")).toBe(true);
    const sessions: Record<string, { directory: string; parentID?: string }> = {
      ses_top: { directory: "/work/repo" },
      ses_child: { directory: "/work/repo", parentID: "ses_top" },
    };
    const client = {
      session: {
        get: async ({ path }: { path: { id: string } }) => {
          if (path.id === "ses_old") throw new Error("404");
          return { data: sessions[path.id] };
        },
      },
    };
    const hooks = (await (exports.CentrailPlugin as (ctx: unknown) => Promise<{ event: (e: unknown) => Promise<void> }>)({ client, directory: "/plugin/dir" }));
    const fire = (event: unknown) => hooks.event({ event });
    await fire({ type: "session.status", properties: { sessionID: "ses_top", status: { type: "busy" } } });
    await fire({ type: "message.updated", properties: {} });
    await fire({ type: "session.status", properties: { sessionID: "ses_top", status: { type: "idle" } } });
    await fire({ type: "session.idle", properties: { sessionID: "ses_top" } }); // the same moment, deprecated twin
    await fire({ type: "session.idle", properties: { sessionID: "ses_child" } });
    await fire({ type: "session.idle", properties: { sessionID: "ses_old" } }); // lookup fails: the plugin's folder
    await expect(fire(null)).resolves.toBeUndefined();
    await expect(fire({ type: "session.idle" })).resolves.toBeUndefined();

    const done = async () => (await readdir(records)).filter((f) => f.startsWith("run-"));
    for (let i = 0; i < 100 && (await done()).length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200)); // nothing else arrives
    const runs = await Promise.all((await done()).map((f) => readFile(join(records, f), "utf-8")));
    const parsed = runs.map((r) => {
      const lines = r.split("\n");
      return { args: lines.slice(0, 5), input: JSON.parse(lines.slice(5).join("\n")) };
    });
    expect(parsed.map((p) => p.args)).toEqual([0, 1].map(() => ["hook", "stop", "--centrail-hook", "--surface", "opencode"]));
    expect(parsed.map((p) => p.input).sort((a, b) => a.session_id.localeCompare(b.session_id))).toEqual([
      { hook_event_name: "session.idle", session_id: "ses_old", cwd: "/plugin/dir" },
      { hook_event_name: "session.idle", session_id: "ses_top", cwd: "/work/repo" },
    ]);
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
    ["cursor", "{}\n"],
    ["opencode", ""],
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
      child.stdin.end(JSON.stringify({ session_id: "s", sessionId: "s", conversation_id: "s", cwd: join(dir, "gone"), workspace_roots: [join(dir, "gone")] }));
    });
    expect(r).toEqual({ code: 0, stdout: reply });
  });
});
