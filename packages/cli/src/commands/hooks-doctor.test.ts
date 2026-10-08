import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { inspectUserHooks, runHooksDoctor } from "./hooks-doctor.js";
import { codexHookCommand, installStopHook } from "./hooks-install.js";

describe("user hook doctor", () => {
  it("reports source, resolution and duplicates without executing hooks or changing files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "centrail-doctor-"));
    try {
      const claude = join(dir, "settings.json");
      const codex = join(dir, "hooks.json");
      const bundle = join(dir, "private-name-with-$dollar.js");
      await writeFile(bundle, 'throw new Error("must not execute");');
      const command = codexHookCommand(process.execPath, bundle);
      await writeFile(claude, JSON.stringify({ enabledPlugins: { "centrail@centrail": true } }));
      const settings = installStopHook({}, command);
      await writeFile(codex, JSON.stringify(settings));
      const before = await readFile(codex, "utf-8");
      const report = await inspectUserHooks(claude, codex);
      expect(report.findings).toEqual([{ source: "Codex user hooks", kind: "pinned CLI", resolves: true }]);
      expect(report.possibleDuplicates).toBe(false);
      const duplicate = { hooks: { Stop: [...settings.hooks!.Stop as unknown[], ...settings.hooks!.Stop as unknown[]] } };
      await writeFile(codex, JSON.stringify(duplicate));
      expect((await inspectUserHooks(claude, codex)).possibleDuplicates).toBe(true);
      await writeFile(codex, before);
      expect(await readFile(codex, "utf-8")).toBe(before);
      expect(JSON.stringify(report)).not.toContain(dir);
      expect(JSON.stringify(report)).not.toContain("private-name");
      const output: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((line) => { output.push(String(line)); });
      try { await runHooksDoctor(claude, codex); }
      finally { log.mockRestore(); }
      expect(output.join("\n")).not.toMatch(/private-name|centrail-doctor-|nodejs|CLAUDE_PLUGIN_ROOT/);
      expect(output.join("\n")).toContain("Codex user hooks: pinned CLI; executable and bundle resolve");
      const json: string[] = [];
      const jlog = vi.spyOn(console, "log").mockImplementation((line) => { json.push(String(line)); });
      try { await runHooksDoctor(claude, codex, { json: true }); }
      finally { jlog.mockRestore(); }
      expect(json).toHaveLength(1);
      const parsed = JSON.parse(json[0]!);
      expect(parsed).toMatchObject({ version: 1, possibleDuplicates: false });
      expect(parsed.findings).toContainEqual({ source: "Codex user hooks", kind: "pinned CLI", resolves: true });
      expect(json[0]).not.toMatch(/private-name|centrail-doctor-|nodejs|CLAUDE_PLUGIN_ROOT/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("keeps ambiguous plugin launchers separate from Centrail duplicate counts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "centrail-doctor-"));
    try {
      const path = join(dir, "hooks.json");
      await writeFile(path, JSON.stringify({ hooks: { Stop: [{ hooks: [
        { type: "command", command: 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh"' },
        { type: "command", command: 'sh "${PLUGIN_ROOT}/scripts/hook.sh"' },
      ] }] } }));
      const report = await inspectUserHooks(join(dir, "settings.json"), path);
      expect(report.findings.map((f) => f.kind)).toEqual(["unattributed plugin launcher", "unattributed plugin launcher"]);
      expect(report.possibleDuplicates).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("redacts malformed configuration and missing paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "centrail-doctor-"));
    try {
      const claude = join(dir, "settings.json");
      const codex = join(dir, "hooks.json");
      await writeFile(claude, '{"private-secret":not valid}');
      await writeFile(codex, JSON.stringify(installStopHook({}, codexHookCommand("/missing/node", "/private-person/tool.js"))));
      const report = await inspectUserHooks(claude, codex);
      expect(report.errors).toEqual(["Claude user settings: cannot read configuration"]);
      expect(report.findings[0].resolves).toBe(false);
      expect(JSON.stringify(report)).not.toMatch(/private-secret|private-person/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
