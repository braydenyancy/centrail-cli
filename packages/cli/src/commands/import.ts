import { readFile } from "node:fs/promises";
import { readAuth } from "../config.js";
import { assertSecureBaseUrl } from "../url.js";
import { versionHeaders } from "../version.js";

// `centrail import <file>` — a `ccusage claude daily --json` or
// `ccusage claude session --json` file becomes Measured-tier history on the
// server: per-day, per-model aggregates in the imported table, never a
// certified event (decision § 3.6). For the machine whose logs are still on
// disk the CLI's own scan is the source; this is for history the scan can no
// longer see — logs rotated, another machine, a ccusage user arriving.
// Nothing in a ccusage row identifies a request, a repo or a session, so
// nothing here is attributed or deduplicated against certified rows.

export type ImportRow = { day: string; model: string; inputTokens: number; outputTokens: number; contextTokens: number };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MODEL = 100;

export function parseCcusageExport(json: unknown): ImportRow[] {
  if (!isObject(json)) throw new Error("Not a ccusage export: expected a JSON object");
  const merged = new Map<string, ImportRow>();
  const add = (day: string, breakdown: unknown) => {
    if (!isObject(breakdown)) throw new Error("Not a ccusage export: a model breakdown is not an object");
    if (typeof breakdown.modelName !== "string" || !breakdown.modelName) throw new Error("Not a ccusage export: a model breakdown has no modelName");
    const model = breakdown.modelName.slice(0, MAX_MODEL);
    const key = `${day}\u0000${model}`;
    const row = merged.get(key) ?? { day, model, inputTokens: 0, outputTokens: 0, contextTokens: 0 };
    row.inputTokens += count(breakdown.inputTokens);
    row.outputTokens += count(breakdown.outputTokens);
    row.contextTokens += count(breakdown.cacheReadTokens) + count(breakdown.cacheCreationTokens);
    merged.set(key, row);
  };
  if (Array.isArray(json.daily)) {
    for (const d of json.daily) {
      if (!isObject(d) || typeof d.date !== "string" || !DAY_RE.test(d.date)) throw new Error("Not a ccusage export: a daily row has no YYYY-MM-DD date");
      for (const b of Array.isArray(d.modelBreakdowns) ? d.modelBreakdowns : []) add(d.date, b);
    }
  } else if (Array.isArray(json.sessions)) {
    // A session spans days; ccusage gives no per-day split, so the whole
    // session lands on the day it last ran (UTC). Stated in the docs.
    for (const s of json.sessions) {
      if (!isObject(s) || typeof s.lastActivity !== "string" || Number.isNaN(Date.parse(s.lastActivity))) throw new Error("Not a ccusage export: a session has no lastActivity");
      const day = new Date(s.lastActivity).toISOString().slice(0, 10);
      for (const b of Array.isArray(s.modelBreakdowns) ? s.modelBreakdowns : []) add(day, b);
    }
  } else {
    throw new Error("Not a ccusage export: expected `daily` (ccusage claude daily --json) or `sessions` (ccusage claude session --json)");
  }
  return [...merged.values()];
}

function count(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error("Not a ccusage export: a token count is not a non-negative integer");
  return v;
}

export async function runImport(file: string, deps: { fetch?: typeof fetch } = {}): Promise<void> {
  const auth = await readAuth();
  if (!auth) throw new Error("Not connected — run `centrail connect` first");
  assertSecureBaseUrl(auth.baseUrl);
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf-8"));
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${(err as Error).message}`);
  }
  const rows = parseCcusageExport(json);
  if (rows.length === 0) {
    console.log("Nothing to import: the file has no usage rows.");
    return;
  }
  const res = await (deps.fetch ?? fetch)(`${auth.baseUrl}/api/import`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${auth.token}`, ...versionHeaders() },
    body: JSON.stringify({ provider: "ccusage", rows }),
  });
  if (res.status === 401) throw new Error("Token revoked or expired — run `centrail connect`");
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(`Import failed (${res.status})${b?.error ? `: ${b.error}` : ""}`);
  }
  const days = new Set(rows.map((r) => r.day));
  console.log(`Imported ${rows.length} day·model row(s) over ${days.size} day(s) as Measured history (provider ccusage). A re-import replaces them.`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
