import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// install-hooks asks the scope question when it was never answered, over the
// REAL config dir; this file must never touch that. Scratch config, scope
// answered, then the module.
process.env.CENTRAIL_CONFIG_DIR = await mkdtemp(join(tmpdir(), "centrail-hooks-cfg-"));
const { parseConfig, writeConfig } = await import("../config.js");
await writeConfig(parseConfig({ scopeDecidedAt: "2026-06-01T00:00:00Z" }));
const { hookCommand, installStopHook, runInstallHooks, uninstallStopHook } = await import("./hooks-install.js");

describe("Stop hook settings merge", () => {
  const cmd = hookCommand("/usr/bin/node", "/opt/centrail/dist/index.js");

  it("adds one entry, keeps every other hook, and is idempotent", () => {
    const settings = {
      model: "opus",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "lint" }] }],
        Stop: [{ hooks: [{ type: "command", command: "node other-stop.mjs" }] }],
      },
    };
    const once = installStopHook(settings, cmd);
    const twice = installStopHook(once, cmd);
    expect(twice).toEqual(once);
    const stop = (once.hooks as { Stop: { hooks: { command: string }[] }[] }).Stop;
    expect(stop).toHaveLength(2);
    expect(stop[0].hooks[0].command).toBe("node other-stop.mjs");
    expect(stop[1].hooks[0]).toEqual({ type: "command", command: cmd, timeout: 10 });
    expect((once.hooks as Record<string, unknown>).PreToolUse).toEqual(settings.hooks.PreToolUse);
    expect(once.model).toBe("opus");
  });

  it("replaces a stale centrail entry pointing at an old install path", () => {
    const stale = installStopHook({}, hookCommand("/old/node", "/old/centrail/index.js"));
    const fresh = installStopHook(stale, cmd);
    const stop = (fresh.hooks as { Stop: { hooks: { command: string }[] }[] }).Stop;
    expect(stop).toHaveLength(1);
    expect(stop[0].hooks[0].command).toBe(cmd);
  });

  it("uninstall removes only ours and drops empty containers", () => {
    const withOther = installStopHook(
      { hooks: { Stop: [{ hooks: [{ type: "command", command: "node other-stop.mjs" }] }] } },
      cmd,
    );
    const after = uninstallStopHook(withOther);
    expect((after.hooks as { Stop: unknown[] }).Stop).toHaveLength(1);
    expect(uninstallStopHook(installStopHook({}, cmd))).toEqual({});
    expect(uninstallStopHook({ a: 1 })).toEqual({ a: 1 });
  });

  it("hookCommand quotes both paths and ends in `hook stop`", () => {
    expect(cmd).toBe('"/usr/bin/node" "/opt/centrail/dist/index.js" hook stop');
    expect(hookCommand("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\j\\centrail\\index.js")).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\j\\centrail\\index.js" hook stop',
    );
  });

  it("install-hooks writes the same Stop entry to Claude Code's settings and to Codex's hooks.json, and removes both", async () => {
    // Codex loads hooks.json from each config layer's folder (its user layer
    // is CODEX_HOME) with the same {hooks: {Stop: [...]}} shape.
    const dir = await mkdtemp(join(tmpdir(), "centrail-hooks-"));
    const claude = join(dir, "claude", "settings.json");
    const codex = join(dir, "codex", "hooks.json");
    await runInstallHooks({ remove: false }, claude, codex);
    const c = JSON.parse(await readFile(claude, "utf-8"));
    const x = JSON.parse(await readFile(codex, "utf-8"));
    expect(c.hooks.Stop).toEqual(x.hooks.Stop);
    expect(x.hooks.Stop[0].hooks[0].command).toBe(hookCommand());
    // A second install changes nothing; another tool's hook in the Codex file survives.
    await writeFile(codex, JSON.stringify({ ...x, hooks: { ...x.hooks, PreToolUse: [{ hooks: [{ type: "command", command: "other" }] }] } }));
    await runInstallHooks({ remove: false }, claude, codex);
    const again = JSON.parse(await readFile(codex, "utf-8"));
    expect(again.hooks.Stop).toEqual(x.hooks.Stop);
    expect(again.hooks.PreToolUse[0].hooks[0].command).toBe("other");
    await runInstallHooks({ remove: true }, claude, codex);
    expect(JSON.parse(await readFile(claude, "utf-8")).hooks).toBeUndefined();
    expect(JSON.parse(await readFile(codex, "utf-8")).hooks.Stop).toBeUndefined();
  });

  it("with the Claude Code plugin enabled, adds no second Claude hook, and still serves Codex", async () => {
    const dir = await mkdtemp(join(tmpdir(), "centrail-hooks-"));
    const claude = join(dir, "settings.json");
    const codex = join(dir, "codex-hooks.json");
    const raw = `${JSON.stringify({ enabledPlugins: { "centrail@centrail": true } }, null, 2)}\n`;
    await writeFile(claude, raw);
    await runInstallHooks({ remove: false }, claude, codex);
    expect(await readFile(claude, "utf-8")).toBe(raw);
    expect(JSON.parse(await readFile(codex, "utf-8")).hooks.Stop).toHaveLength(1);
  });

  it("rewrites in the file's own indentation, keeps the file as first found once, and refuses one it cannot parse", async () => {
    const dir = await mkdtemp(join(tmpdir(), "centrail-hooks-"));
    const claude = join(dir, "settings.json");
    const tabbed = `${JSON.stringify({ model: "opus" }, null, "\t")}\n`;
    await writeFile(claude, tabbed);
    await runInstallHooks({ remove: false }, claude, join(dir, "codex.json"));
    await runInstallHooks({ remove: true }, claude, join(dir, "codex.json"));
    expect(await readFile(claude, "utf-8")).toBe(tabbed);
    expect(await readFile(`${claude}.centrail-backup`, "utf-8")).toBe(tabbed);
    await writeFile(claude, "{ not json");
    await expect(runInstallHooks({ remove: false }, claude, join(dir, "codex.json"))).rejects.toThrow(/Cannot parse/);
    expect(await readFile(claude, "utf-8")).toBe("{ not json");
  });
});

