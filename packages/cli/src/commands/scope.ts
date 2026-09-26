import { createInterface } from "node:readline/promises";
import { SCANNERS, type ParsedUsageEvent } from "@centrail/parsers";
import { ensureInstallId, readConfig, updateConfig, writeConfig, type Config } from "../config.js";
import { IdentityResolver } from "../resolver.js";
import { parseSelection, renderRepoRows, summarizeRepos, surfaceEnabled, type RepoRow } from "../scope.js";

// `centrail setup` — the consent moment (decision doc § 3.7). Lists every
// repo and folder this machine's agents have touched, with the identity
// each will ship under, and asks once. Also run by `connect` and
// `install-hooks` when the question has not been answered yet.
//
// Interactive when stdin is a terminal (or when run as `setup` explicitly);
// headless `connect` prints the list, defaults to all, and says how to change
// it — the list was shown before anything left, which is the point.

export async function discoverRepos(): Promise<RepoRow[]> {
  const installId = await ensureInstallId();
  const resolver = await IdentityResolver.create(installId);
  const events: ParsedUsageEvent[] = [];
  for (const scanner of SCANNERS) {
    try {
      events.push(...(await scanner.scan({})));
    } catch {
      // one unreadable surface must not hide the others
    }
  }
  for (const e of events) await resolver.stamp(e);
  return summarizeRepos(events);
}

export async function runSetup(opts: { interactive: boolean }): Promise<void> {
  const cfg = await readConfig();
  console.log("  Scanning local agent logs…");
  const rows = await discoverRepos();
  printScope(rows, cfg);

  if (rows.length === 0 || !opts.interactive) {
    if (!cfg.scopeDecidedAt) {
      cfg.scopeDecidedAt = new Date().toISOString();
      await writeConfig(cfg);
    }
    console.log("  Change any time: `centrail setup`, `centrail exclude <repo>`, `centrail repos`.");
    return;
  }

  // A line iterator, not rl.question(): question() drops lines that arrive
  // before it is called, which is exactly what piped or pasted input does.
  const rl = createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt: string): Promise<string> => {
    process.stdout.write(prompt);
    const next = await lines.next();
    if (next.done) process.stdout.write("\n");
    return next.done ? "" : String(next.value);
  };
  try {
    const all = (await ask("  Sync all of these, and any new repo this machine touches? [Y/n] ")).trim().toLowerCase();
    if (all === "" || all.startsWith("y")) {
      if (cfg.mode === "allow") cfg.pendingBackfill = true;
      cfg.mode = "all";
    } else {
      const answer = await ask("  Numbers to EXCLUDE (e.g. 2,5), or `only 1,3` to sync just those: ");
      const sel = parseSelection(answer, rows.length);
      if (sel) {
        const keys = sel.picks.map((i) => rows[i].key);
        if (sel.mode === "allow") {
          cfg.mode = "allow";
          cfg.allowRepos = keys;
          cfg.pendingBackfill = true;
        } else {
          cfg.mode = "all";
          for (const k of keys) if (!cfg.denyRepos.includes(k)) cfg.denyRepos.push(k);
        }
      }
    }
  } finally {
    rl.close();
  }
  cfg.scopeDecidedAt = new Date().toISOString();
  await writeConfig(cfg);
  console.log("");
  printScope(rows, cfg);
  console.log("  Saved. Change any time: `centrail exclude <repo>`, `centrail include <repo>`, `centrail repos`.");
}

export async function runRepos(): Promise<void> {
  const cfg = await readConfig();
  printScope(await discoverRepos(), cfg);
}

function printScope(rows: RepoRow[], cfg: Config): void {
  const repos = rows.filter((r) => r.source !== "folder").length;
  const folders = rows.length - repos;
  console.log("");
  console.log(`  This machine's agents have touched ${repos} repo(s) and ${folders} folder(s):`);
  for (const line of renderRepoRows(rows, cfg)) console.log(`  ${line}`);
  if (rows.length === 0) console.log("    (nothing yet)");
  const legend = cfg.mode === "allow" ? "✓ synced  ✗ excluded  … waiting (allow mode: only listed repos sync)" : "✓ synced  ✗ excluded";
  console.log(`  ${legend}`);
  const surfaces = SCANNERS.map((s) => `${s.surface} ${surfaceEnabled(cfg, s.surface) ? "on" : "off"}`).join("  ");
  console.log(`  Surfaces: ${surfaces}   (centrail surfaces <name> on|off)`);
}

// Widening the scope sets pendingBackfill: events held back earlier were
// scanned and the watermark moved past them, so only a full rescan (once)
// brings the repo's history in. Narrowing never needs it.
export async function runInclude(name: string): Promise<void> {
  const cfg = await updateConfig((c) => {
    c.denyRepos = c.denyRepos.filter((r) => r !== name);
    if (!c.allowRepos.includes(name)) c.allowRepos.push(name);
    c.pendingBackfill = true;
  });
  console.log(
    cfg.mode === "allow"
      ? `Included "${name}" — it syncs from the next run.`
      : `Included "${name}" — it was ${cfg.denyRepos.includes(name) ? "excluded" : "already syncing"} (mode: all).`,
  );
}

export async function runExclude(name: string): Promise<void> {
  await updateConfig((c) => {
    c.allowRepos = c.allowRepos.filter((r) => r !== name);
    if (!c.denyRepos.includes(name)) c.denyRepos.push(name);
  });
  console.log(`Excluded "${name}" — nothing about it leaves this machine from the next sync (events, commits, identity).`);
}

export async function runSurfaces(args: string[]): Promise<void> {
  const [name, state] = args;
  const known = SCANNERS.map((s) => s.surface);
  if (!name) {
    const cfg = await readConfig();
    for (const s of known) console.log(`  ${s.padEnd(12)} ${surfaceEnabled(cfg, s) ? "on" : "off"}`);
    return;
  }
  if (!known.includes(name) || (state !== "on" && state !== "off")) {
    throw new Error(`Usage: centrail surfaces <${known.join("|")}> on|off`);
  }
  await updateConfig((c) => {
    c.surfaces[name] = state === "on";
  });
  console.log(`${name}: ${state}`);
}
