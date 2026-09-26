import { describe, expect, it } from "vitest";
import { hookCommand, installStopHook, uninstallStopHook } from "./hooks-install.js";

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
});
