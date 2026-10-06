// The Claude Code / Codex plugin: one hooks.json over the same bundle. The
// plugin carries its own copy of the CLI bundle (hash-pinned by the plugin
// version; never resolved from the network per turn), so the test runs
// THAT file as the harness would — a Stop input on stdin — and expects a
// sidecar line, nothing on stdout, exit 0.
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
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
    expect(stop[0].hooks).toEqual([{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/centrail.mjs" hook stop', timeout: 10 }]);
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
    const run = (input: string) =>
      new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
        const child = spawn(process.execPath, [join(PLUGIN, "scripts", "centrail.mjs"), "hook", "stop"], { env: { ...process.env, CENTRAIL_CONFIG_DIR: cfg, CLAUDE_PLUGIN_ROOT: PLUGIN } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", (code) => resolve({ stdout, stderr, code }));
        child.stdin.end(input);
      });
    const { stdout, stderr, code } = await run(JSON.stringify({ session_id: "s-plugin", cwd: repo, hook_event_name: "Stop", stop_hook_active: false }));
    expect([stdout, stderr, code]).toEqual(["", "", 0]);
    const lines = await readSidecar(join(cfg, "sessions.jsonl"));
    expect(lines.get("s-plugin")?.repo?.key).toBe("github.com/acme/r");
    expect(await run("not json")).toEqual({ stdout: "", stderr: "", code: 0 });
    await rm(cfg, { recursive: true, force: true });
  });
});
