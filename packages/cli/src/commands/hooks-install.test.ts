import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The settings merge every installer form goes through. Setup's end-to-end
// behaviour over scratch agent homes is in integrations.test.ts.
process.env.CENTRAIL_CONFIG_DIR = await mkdtemp(join(tmpdir(), "centrail-hooks-cfg-"));
const { hookCommand, installStopHook, isCentrailCommand, launcherCommand, stableInstallPath, uninstallStopHook } = await import("./hooks-install.js");

describe("Stop hook settings merge", () => {
  const cmd = hookCommand("/usr/bin/node", "/opt/centrail/dist/index.js");

  it("removes owned handlers inside a mixed group without deleting other handlers or group metadata", () => {
    const other = { type: "command", command: "node other-stop.mjs" };
    const settings = { hooks: { Stop: [{ matcher: "*", custom: "keep", hooks: [other, { type: "command", command: cmd }] }] } };
    expect(uninstallStopHook(settings)).toEqual({ hooks: { Stop: [{ matcher: "*", custom: "keep", hooks: [other] }] } });
  });

  it("recognises stale absolute plugin launchers, but never claims another plugin's generic root launcher", () => {
    const other = { type: "command", command: 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh"' };
    const stale = { hooks: { Stop: [{ hooks: [
      { type: "command", command: 'sh "/old/plugins/centrail/scripts/hook.sh"' },
      { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/centrail.mjs" hook stop' },
      other,
    ] }] } };
    expect(uninstallStopHook(stale)).toEqual({ hooks: { Stop: [{ hooks: [other] }] } });
  });

  it("does not delete unrelated commands merely mentioning centrail and hook stop", () => {
    const settings = { hooks: { Stop: [{ hooks: [{ type: "command", command: 'echo "centrail hook stop"' }] }] } };
    expect(uninstallStopHook(settings)).toEqual(settings);
  });

  it("round-trips owned launchers from arbitrary install folders and quoted punctuation", () => {
    for (const script of ["/opt/tool/dist/index.js", '/tmp/a;& $money`tag` "quoted"/dist/index.js']) {
      const command = hookCommand("/usr/bin/node", script, "linux");
      const once = installStopHook({}, command);
      expect(installStopHook(once, command)).toEqual(once);
      expect(uninstallStopHook(once)).toEqual({});
    }
    const windows = hookCommand("C:\\Program Files\\nodejs\\node.exe", "C:\\a;& folder\\tool\\index.js", "win32");
    expect(uninstallStopHook(installStopHook({}, windows))).toEqual({});
    const renamedRuntime = hookCommand("/custom/runtime", "/custom/entry.js", "linux");
    expect(uninstallStopHook(installStopHook({}, renamedRuntime))).toEqual({});
  });

  it("deduplicates old CLI, old direct-node plugin and stale absolute plugin launchers on update", () => {
    const other = { type: "command", command: "other-stop" };
    const stale = { hooks: { Stop: [{ hooks: [other,
      { type: "command", command: '"/old/node" "/old/centrail/dist/index.js" hook stop' },
      { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/centrail.mjs" hook stop' },
      { type: "command", command: 'sh "/cache/centrail/0.7.2/scripts/hook.sh"' },
    ] }] } };
    const updated = installStopHook(stale, cmd);
    expect(updated.hooks!.Stop).toEqual([{ hooks: [other] }, { hooks: [{ type: "command", command: cmd, timeout: 10 }] }]);
    expect(installStopHook(updated, cmd)).toEqual(updated);
  });

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

  it("launcherCommand: one quoted launcher path and fixed arguments, owned, and replaces any older form", () => {
    const codex = launcherCommand("/home/u/.config/centrail/bin/centrail-hook", "codex", "linux");
    expect(codex).toBe('"/home/u/.config/centrail/bin/centrail-hook" hook stop --centrail-hook --surface codex');
    expect(launcherCommand("/x/centrail-hook", "claude-code", "linux")).toBe('"/x/centrail-hook" hook stop --centrail-hook');
    const win = launcherCommand("C:\\Users\\j\\.config\\centrail\\bin\\centrail-hook.cmd", "codex", "win32");
    expect(win).toBe('"C:\\Users\\j\\.config\\centrail\\bin\\centrail-hook.cmd" hook stop --centrail-hook --surface codex');
    for (const c of [codex, win]) expect(isCentrailCommand(c)).toBe(true);
    // Without the ownership marker, a script that happens to share the name is not ours.
    expect(isCentrailCommand('"/x/centrail-hook" hook stop')).toBe(false);
    expect(isCentrailCommand('centrail-hook hook stop --centrail-hook')).toBe(false); // relative: not an emitted form
    const migrated = installStopHook(installStopHook({}, `${cmd} --surface codex`), codex);
    expect(migrated.hooks!.Stop).toEqual([{ hooks: [{ type: "command", command: codex, timeout: 10 }] }]);
    expect(uninstallStopHook(migrated)).toEqual({});
  });

  it("hookCommand quotes both paths and includes a stable ownership marker", () => {
    expect(cmd).toBe('"/usr/bin/node" "/opt/centrail/dist/index.js" hook stop --centrail-hook');
    expect(hookCommand("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\j\\centrail\\index.js", "win32")).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\j\\centrail\\index.js" hook stop --centrail-hook',
    );
  });

});

describe("stableInstallPath: a version manager's alias, so an upgrade or prune does not strand the hook", () => {
  // mise's layout: installs/<tool>/<version>/… with alias links beside it.
  async function installs(versions: string[], aliases: Record<string, string>) {
    const root = join(await mkdtemp(join(tmpdir(), "centrail-installs-")), "installs");
    for (const v of versions) {
      mkdirSync(join(root, "node", v, "bin"), { recursive: true });
      writeFileSync(join(root, "node", v, "bin", "node"), "");
    }
    // A junction needs no privilege on Windows and is a plain dir link elsewhere.
    for (const [alias, v] of Object.entries(aliases)) symlinkSync(join(root, "node", v), join(root, "node", alias), "junction");
    return (v: string) => join(root, "node", v, "bin", "node");
  }

  it.each([
    ["latest when it is this install", ["24.21.0"], { latest: "24.21.0", "24": "24.21.0" }, "latest"],
    ["the major when latest is a newer major", ["24.21.0", "26.0.0"], { latest: "26.0.0", "24": "24.21.0" }, "24"],
    ["the version itself when no alias is this install", ["24.21.0", "26.0.0"], { latest: "26.0.0" }, "24.21.0"],
    ["the version itself without aliases (asdf, plain installs)", ["24.21.0"], {}, "24.21.0"],
  ])("picks %s", async (_, versions, aliases, expected) => {
    const node = await installs(versions, aliases);
    expect(stableInstallPath(node("24.21.0"))).toBe(node(expected));
  });

  it("leaves a path outside any installs/ tree alone", () => {
    expect(stableInstallPath("/usr/bin/node")).toBe("/usr/bin/node");
  });

  it("is what hookCommand pins", async () => {
    const node = await installs(["24.21.0"], { latest: "24.21.0" });
    const cmd = hookCommand(node("24.21.0"), "/opt/centrail/dist/index.js");
    expect(cmd).toContain(node("latest"));
    expect(cmd).not.toContain(node("24.21.0"));
  });
});
