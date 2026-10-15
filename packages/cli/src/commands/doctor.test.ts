import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `centrail doctor` over scratch agent homes and a scratch centrail config
// (state.json carries the version records a sync saved). Read-only unless
// --fix; never prints a path or command.
const cfg = vi.hoisted(() => {
  const d = `${process.env.TMPDIR ?? "/tmp"}/centrail-doctor-test-${process.pid}-${Date.now()}`;
  process.env.CENTRAIL_CONFIG_DIR = d;
  return d;
});

import { parseConfig, writeConfig } from "../config.js";
import { CLI_VERSION } from "../version.js";
import { doctorReport, runDoctor } from "./doctor.js";
import { hookCommand, installStopHook } from "./hooks-install.js";
import { runIntegrationSetup, type IntegrationDeps } from "./integrations.js";

const win = process.platform === "win32";
let root: string;
let deps: IntegrationDeps;
let out: string;

beforeEach(async () => {
  await rm(cfg, { recursive: true, force: true });
  await writeConfig(parseConfig({ scopeDecidedAt: "2026-06-01T00:00:00Z" }));
  root = await mkdtemp(join(tmpdir(), "centrail-doctor-machine-"));
  await mkdir(join(root, "codex"));
  // npx: no stable install, so the launcher resolves through PATH; a fake npx is on it.
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", win ? "npx.cmd" : "npx"), "", { mode: 0o755 });
  deps = {
    env: { PATH: join(root, "bin"), PATHEXT: ".CMD" },
    claudeDir: join(root, "claude"),
    codexHome: join(root, "codex"),
    geminiHome: join(root, "home", ".gemini"),
    copilotHome: join(root, "copilot"),
    piAgentDir: join(root, "pi", "agent"),
    cursorHome: join(root, "home", ".cursor"),
    opencodeConfigDir: join(root, "xdg", "opencode"),
    configDir: join(root, "centrail"),
    claude: null,
    script: "/home/u/.npm/_npx/1/node_modules/centrail/dist/index.js",
    node: "/usr/bin/node",
  };
  out = "";
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void (out += `${a.map(String).join(" ")}\n`));
  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await rm(root, { recursive: true, force: true });
});

const setState = (state: unknown) => writeFile(join(cfg, "state.json"), JSON.stringify(state));
const installedPlugin = async (version: string) => {
  await mkdir(join(root, "claude", "plugins"), { recursive: true });
  await writeFile(join(root, "claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "centrail@centrail": [{ scope: "user", version }] } }));
};

const notDetected = { detected: false, integration: "none", plugin: null, hooks: 0, usesLauncher: null, commandResolves: null, usage: true, status: "not-detected", fix: "ok" };

describe("centrail doctor", () => {
  it("reports a stable JSON shape, exit 0 once set up", async () => {
    await runIntegrationSetup({ yes: true }, deps);
    vi.mocked(console.log).mockClear();
    out = "";
    const report = await runDoctor({ json: true }, deps);
    expect(process.exitCode).toBeUndefined();
    const printed = JSON.parse(out);
    expect(printed).toEqual(report);
    expect(printed).toEqual({
      version: 2,
      ok: true,
      cli: { version: CLI_VERSION, copy: "npx", latest: null, updateAvailable: false },
      launcher: { needed: true, present: true, executable: true, resolvesCli: true },
      agents: {
        "claude-code": { detected: false, integration: "none", plugin: { enabled: false, autoUpdate: false, version: null }, hooks: 0, usesLauncher: null, commandResolves: null, usage: true, status: "not-detected", fix: "ok" },
        codex: { detected: true, integration: "hook", plugin: null, hooks: 1, usesLauncher: true, commandResolves: true, usage: true, status: "ok", fix: "ok" },
        "gemini-cli": notDetected,
        "copilot-cli": notDetected,
        pi: notDetected,
        cursor: { ...notDetected, usage: false },
        opencode: { ...notDetected, usage: false },
      },
      notices: [],
    });
    expect(out).not.toContain(root);
  });

  it("flags an outdated pinned Codex command, exits 1, and --fix moves it to the launcher", async () => {
    await writeFile(join(root, "codex", "hooks.json"), JSON.stringify(installStopHook({}, `${hookCommand("/old/node", "/old/centrail/dist/index.js")} --surface codex`)));
    await runDoctor({}, deps);
    expect(process.exitCode).toBe(1);
    expect(out).toMatch(/Codex {8}outdated pinned command/);
    expect(out).toContain("Needs action: run `centrail doctor --fix`");
    expect(out).not.toMatch(/\/old\/|centrail-doctor-machine/);

    process.exitCode = undefined;
    const fixed = await runDoctor({ fix: true }, deps);
    expect(fixed.ok).toBe(true);
    expect(process.exitCode).toBeUndefined();
    expect(await readFile(join(root, "codex", "hooks.json"), "utf-8")).toContain("centrail-hook");
  });

  it.each([
    ["missing", {}],
    ["duplicate", { hooks: { Stop: [1, 2].map(() => ({ hooks: [{ type: "command", command: `${hookCommand("/n", "/c/centrail/dist/index.js")} --surface codex` }] })) } }],
  ])("%s → needs action", async (status, file) => {
    await writeFile(join(root, "codex", "hooks.json"), JSON.stringify(file));
    const r = await doctorReport(deps);
    expect(r.agents.codex.status).toBe(status);
    expect(r.ok).toBe(false);
  });

  it("a launcher entry whose launcher was deleted does not resolve", async () => {
    await runIntegrationSetup({ yes: true }, deps);
    await rm(join(root, "centrail"), { recursive: true });
    const r = await doctorReport(deps);
    expect(r.agents.codex).toMatchObject({ status: "unresolved", commandResolves: false, fix: "update" });
    expect(r.launcher).toMatchObject({ needed: true, present: false });
  });

  it("does not repeat a plugin update notice once Claude Code installed that version", async () => {
    await setState({ surfaces: {}, updateNotice: { version: "0.7.3", channel: "plugin", latest: "0.8.1" } });
    await installedPlugin("0.7.3");
    expect((await doctorReport(deps)).notices).toEqual([
      { copy: "plugin", kind: "update-available", line: "Claude Code plugin: centrail 0.8.1 is available (you have 0.7.3): update it in Claude Code with `/plugin marketplace update centrail`." },
    ]);
    await installedPlugin("0.8.1");
    expect((await doctorReport(deps)).notices).toEqual([]);
  });

  it("a copy below the server's minimum needs action; an available update does not", async () => {
    await runIntegrationSetup({ yes: true }, deps);
    await setState({ surfaces: {}, updateNotice: { version: CLI_VERSION, channel: "npx", latest: "99.0.0" } });
    const behind = await doctorReport(deps);
    expect(behind.cli).toMatchObject({ latest: "99.0.0", updateAvailable: true });
    expect(behind.ok).toBe(true);
    await setState({ surfaces: {}, outdated: { version: "0.1.0", channel: "mise", minimum: "0.5.0" } });
    const parked = await doctorReport(deps);
    expect(parked.notices.map((n) => n.kind)).toEqual(["below-minimum"]);
    expect(parked.ok).toBe(false);
  });

  describe("Gemini CLI, Copilot CLI and Pi", () => {
    const gemini = () => join(root, "home", ".gemini", "settings.json");
    const copilot = () => join(root, "copilot", "hooks", "centrail.json");
    const pi = () => join(root, "pi", "agent", "extensions", "centrail.js");
    beforeEach(async () => {
      for (const d of [join(root, "home", ".gemini"), join(root, "copilot"), join(root, "pi", "agent")]) await mkdir(d, { recursive: true });
    });

    it("not set up → missing, exit 1; --fix sets all three up; then ok, exit 0", async () => {
      const before = await runDoctor({ json: true }, deps);
      expect(process.exitCode).toBe(1);
      expect(out).not.toContain(root); // the report names no path
      for (const a of ["gemini-cli", "copilot-cli", "pi"] as const) expect(before.agents[a]).toMatchObject({ detected: true, status: "missing", fix: "install" });

      process.exitCode = undefined;
      out = "";
      const after = await runDoctor({ fix: true }, deps);
      expect(after.ok).toBe(true);
      expect(process.exitCode).toBeUndefined();
      expect(out).toMatch(/Gemini CLI {3}ok: AfterAgent hook through the launcher/);
      expect(out).toMatch(/Copilot CLI {2}ok: agentStop hook through the launcher/);
      expect(out).toMatch(/Pi {11}ok: extension through the launcher/);
      for (const a of ["gemini-cli", "copilot-cli", "pi"] as const) {
        expect(after.agents[a]).toEqual({ detected: true, integration: "hook", plugin: null, hooks: 1, usesLauncher: true, commandResolves: true, usage: true, status: "ok", fix: "ok" });
      }
    });

    it("an entry this centrail would write differently is outdated; a deleted launcher leaves them unresolved", async () => {
      await runIntegrationSetup({ yes: true }, deps);
      await writeFile(pi(), (await readFile(pi(), "utf-8")).replace("agent_end", "agent_settled"));
      const file = JSON.parse(await readFile(copilot(), "utf-8"));
      file.hooks.agentStop[0].timeoutSec = 30; // a user edit to anything but the command is kept and fine
      await writeFile(copilot(), JSON.stringify(file));
      const r = await doctorReport(deps);
      expect(r.agents.pi).toMatchObject({ status: "outdated", fix: "update" });
      expect(r.agents["copilot-cli"].status).toBe("ok");
      expect(r.ok).toBe(false);

      await rm(join(root, "centrail"), { recursive: true });
      const gone = await doctorReport(deps);
      for (const a of ["gemini-cli", "copilot-cli", "pi"] as const) expect(gone.agents[a]).toMatchObject({ status: "unresolved", commandResolves: false });
      expect(gone.launcher).toMatchObject({ needed: true, present: false });
    });

    it("an unparsable settings.json, or a centrail.js that is not centrail's, is unreadable and left alone", async () => {
      await writeFile(gemini(), "{ // comment\n}");
      await mkdir(join(pi(), ".."), { recursive: true });
      await writeFile(pi(), "export default () => {}\n");
      const r = await runDoctor({ fix: true }, deps);
      expect(r.agents["gemini-cli"].status).toBe("unreadable");
      expect(r.agents.pi.status).toBe("unreadable");
      expect(await readFile(gemini(), "utf-8")).toBe("{ // comment\n}");
      expect(await readFile(pi(), "utf-8")).toBe("export default () => {}\n");
    });
  });

  // No usage source reads them: shown, never failed on, never added by --fix;
  // once named and set up, checked like any other entry.
  describe("Cursor and OpenCode", () => {
    const cursor = () => join(root, "home", ".cursor", "hooks.json");
    const opencode = () => join(root, "xdg", "opencode", "plugins", "centrail.js");
    beforeEach(async () => {
      for (const d of [join(root, "home", ".cursor"), join(root, "xdg", "opencode")]) await mkdir(d, { recursive: true });
    });

    it("detected without an entry → not-supported, exit 0, and --fix adds nothing", async () => {
      await runIntegrationSetup({ yes: true }, deps); // Codex only
      out = "";
      const r = await runDoctor({ fix: true, json: true }, deps);
      expect(process.exitCode).toBeUndefined();
      expect(r.ok).toBe(true);
      for (const a of ["cursor", "opencode"] as const) {
        expect(r.agents[a]).toEqual({ detected: true, integration: "none", plugin: null, hooks: 0, usesLauncher: null, commandResolves: null, usage: false, status: "not-supported", fix: "skip" });
      }
      await expect(readFile(cursor(), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(opencode(), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
      out = "";
      await runDoctor({}, deps);
      expect(out).toMatch(/Cursor {7}usage collection not supported yet \(no usage source\); nothing installed/);
      expect(out).toMatch(/OpenCode {5}usage collection not supported yet/);
      expect(out).toContain("Nothing needs action.");
    });

    it("set up by name → ok, labelled repo identity only; a broken entry needs action and --fix repairs it", async () => {
      await runIntegrationSetup({ yes: true, agents: ["codex", "cursor", "opencode"] }, deps);
      const r = await runDoctor({}, deps);
      expect(r.ok).toBe(true);
      expect(out).toMatch(/Cursor {7}ok: stop hook through the launcher \(repo identity only; usage not collected yet\)/);
      expect(out).toMatch(/OpenCode {5}ok: plugin through the launcher \(repo identity only; usage not collected yet\)/);
      for (const a of ["cursor", "opencode"] as const) expect(r.agents[a]).toMatchObject({ integration: "hook", hooks: 1, usage: false, status: "ok" });

      await writeFile(opencode(), (await readFile(opencode(), "utf-8")).replace("session.idle", "session.ended"));
      const file = JSON.parse(await readFile(cursor(), "utf-8"));
      file.hooks.stop.push({ ...file.hooks.stop[0] });
      await writeFile(cursor(), JSON.stringify(file));
      const broken = await doctorReport(deps);
      expect(broken.agents.opencode).toMatchObject({ status: "outdated", fix: "update" });
      expect(broken.agents.cursor).toMatchObject({ status: "duplicate", fix: "repair" });
      expect(broken.ok).toBe(false);

      const fixed = await runDoctor({ fix: true }, deps);
      expect(fixed.ok).toBe(true);
      expect(JSON.parse(await readFile(cursor(), "utf-8")).hooks.stop).toHaveLength(1);
    });
  });
});
