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
        "claude-code": { detected: false, integration: "none", plugin: { enabled: false, autoUpdate: false, version: null }, hooks: 0, usesLauncher: null, commandResolves: null, status: "not-detected", fix: "ok" },
        codex: { detected: true, integration: "hook", plugin: null, hooks: 1, usesLauncher: true, commandResolves: true, status: "ok", fix: "ok" },
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
});
