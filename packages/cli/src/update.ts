import { realpathSync } from "node:fs";
import type { SyncState } from "./watermarks.js";
import { CLI_VERSION } from "./version.js";

// Keeping the CLI current (decision B, 2026-10-07): each install channel has
// its own updater, and the CLI never installs itself. The server says which
// release is latest and which is the oldest it still accepts (capabilities
// `cli`, CONTRACT.md); the CLI says so once, with the one command that
// updates the copy that is running, and below the minimum it stops the
// hook from syncing until its version changes.

export type CliVersions = { latest?: string; minimum?: string };

// Where this copy came from, read from where its script lives.
export type UpdateChannel = "plugin" | "npx" | "mise" | "npm-global" | "unknown";

// What a sync learned about one install's version. `version` and `channel`
// name the copy that ran: a hook's plugin bundle and a hand-run `npx` are
// two copies on one machine, and each keeps or clears only its own record.
export type VersionRecord = { version: string; channel: UpdateChannel };
export type UpdateNotice = VersionRecord & { latest: string };
export type Outdated = VersionRecord & { minimum?: string };

export function detectChannel(script: string = process.argv[1] ?? "", env: Record<string, string | undefined> = process.env): UpdateChannel {
  const p = realpath(script).replace(/\\/g, "/");
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT?.replace(/\\/g, "/").replace(/\/+$/, "");
  // The bundle is copied into the plugin as scripts/centrail.mjs and is
  // never published to npm under that name.
  if ((pluginRoot && p.startsWith(`${pluginRoot}/`)) || p.endsWith("/scripts/centrail.mjs")) return "plugin";
  if (p.includes("/_npx/")) return "npx";
  if (p.includes("/installs/npm-centrail/")) return "mise"; // mise's npm backend, under its data dir
  // A global prefix: <prefix>/lib/node_modules (Unix), %AppData%\npm\node_modules
  // (Windows). Volta keeps the same shape under its own updater.
  if (/\/(lib|npm)\/node_modules\/centrail\//.test(p) && !p.includes("/.volta/")) return "npm-global";
  return "unknown";
}

export function howToUpdate(channel: UpdateChannel): string {
  switch (channel) {
    case "plugin":
      return "it updates through Claude Code (/plugin)";
    case "npx":
      return "run `npx centrail@latest`";
    case "mise":
      return "run `mise upgrade npm:centrail`";
    case "npm-global":
      return "run `npm i -g centrail@latest`";
    default:
      return "update it the way you installed it (`npm i -g centrail@latest` for a global install)";
  }
}

export function updateNoticeLine(n: UpdateNotice): string {
  return `centrail ${n.latest} is available (you have ${n.version}): ${howToUpdate(n.channel)}.`;
}

export function outdatedLine(o: Outdated): string {
  const floor = o.minimum ? ` (${o.minimum} or newer)` : "";
  return `centrail ${o.version} is older than the server accepts${floor}, so syncing has stopped until it is updated: ${howToUpdate(o.channel)}.`;
}

export function here(channel: UpdateChannel = detectChannel()): VersionRecord {
  return { version: CLI_VERSION, channel };
}

// One install, before and after an update: the same copy (version), or the
// same channel, which an update replaces in place.
export function sameInstall(rec: VersionRecord, at: VersionRecord): boolean {
  return rec.version === at.version || rec.channel === at.channel;
}

// Folds what the server said (capabilities `cli`) into the state: a notice
// while this copy is behind the latest release, a park while it is below the
// minimum, and either cleared once the same install has caught up. A field
// the server did not send changes nothing (older servers send none).
// Returns whether the state changed.
export function settleVersions(state: SyncState, cli: CliVersions | undefined, at: VersionRecord): boolean {
  const before = JSON.stringify([state.updateNotice, state.outdated]);
  if (cli?.latest) {
    if (isOlder(at.version, cli.latest)) state.updateNotice = { ...at, latest: cli.latest };
    else if (state.updateNotice && sameInstall(state.updateNotice, at)) delete state.updateNotice;
  }
  if (cli?.minimum) {
    if (isOlder(at.version, cli.minimum)) state.outdated = { ...at, minimum: cli.minimum };
    else if (state.outdated && sameInstall(state.outdated, at)) delete state.outdated;
  }
  return JSON.stringify([state.updateNotice, state.outdated]) !== before;
}

// Whether the Stop hook of this version may start a sync. A parked version
// stays parked until the hook runs a different one (the plugin or the
// global install updated) or a sync by hand finds it accepted again.
export function hookParked(state: Pick<SyncState, "outdated">, version: string = CLI_VERSION): boolean {
  return state.outdated?.version === version;
}

// What `centrail status` shows of a saved record: another copy's as it is,
// this install's only while the copy running is still below `floor` (the
// latest, or the minimum; with no minimum known, while it is the same
// version). Once this install has caught up, the record is stale.
export function stillTrue<T extends VersionRecord>(rec: T | undefined, at: VersionRecord, floor: string | undefined): T | undefined {
  if (!rec || !sameInstall(rec, at)) return rec;
  return (floor ? isOlder(at.version, floor) : rec.version === at.version) ? rec : undefined;
}

// The server refused this version. Thrown past the best-effort catches of
// the attribute calls, so a sync ends on the one line that says what to do.
export class CliOutdatedError extends Error {
  constructor(readonly outdated: Outdated) {
    super(outdatedLine(outdated));
  }
}

// A 426's body: `{ error, code: "cli_outdated", minimum }`.
export async function minimumFrom(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => null)) as { minimum?: unknown } | null;
  return validVersion(body?.minimum) ? body.minimum : undefined;
}

// The capabilities `cli` object, kept only when its versions parse.
export function parseCliVersions(raw: unknown): CliVersions | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const out: CliVersions = {};
  if (validVersion(o.latest)) out.latest = o.latest;
  if (validVersion(o.minimum)) out.minimum = o.minimum;
  return out.latest || out.minimum ? out : undefined;
}

// state.json's records, as written above; anything else reads as absent.
export function parseUpdateNotice(raw: unknown): UpdateNotice | undefined {
  const rec = parseVersionRecord(raw);
  const latest = (raw as { latest?: unknown } | undefined)?.latest;
  return rec && validVersion(latest) ? { ...rec, latest } : undefined;
}

export function parseOutdated(raw: unknown): Outdated | undefined {
  const rec = parseVersionRecord(raw);
  const minimum = (raw as { minimum?: unknown } | undefined)?.minimum;
  return rec ? { ...rec, ...(validVersion(minimum) ? { minimum } : {}) } : undefined;
}

function parseVersionRecord(raw: unknown): VersionRecord | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (!validVersion(o.version)) return undefined;
  const channel = CHANNELS.includes(o.channel as UpdateChannel) ? (o.channel as UpdateChannel) : "unknown";
  return { version: o.version, channel };
}

const CHANNELS: UpdateChannel[] = ["plugin", "npx", "mise", "npm-global", "unknown"];

// Semantic versions (semver.org § 11): numeric fields in order, and a
// pre-release sorts below its release. Build metadata is ignored.
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function validVersion(v: unknown): v is string {
  return typeof v === "string" && SEMVER.test(v);
}

// Negative when a < b, zero when equal, positive when a > b. An unparsable
// version compares equal to everything: nothing is claimed about it.
export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return Math.sign(d);
  }
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const p = x[4].split(".");
  const q = y[4].split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const m = /^\d+$/.test(p[i]);
    const n = /^\d+$/.test(q[i]);
    if (m && n) {
      const d = Number(p[i]) - Number(q[i]);
      if (d !== 0) return Math.sign(d);
    } else if (m !== n) {
      return m ? -1 : 1; // numeric identifiers sort below alphanumeric ones
    } else if (p[i] !== q[i]) {
      return p[i] < q[i] ? -1 : 1;
    }
  }
  return 0;
}

export function isOlder(v: string, than: string): boolean {
  return compareVersions(v, than) < 0;
}

function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
