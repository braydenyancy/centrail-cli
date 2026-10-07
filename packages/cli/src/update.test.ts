import { describe, expect, it } from "vitest";
import {
  compareVersions,
  detectChannel,
  hookParked,
  howToUpdate,
  outdatedLine,
  parseCliVersions,
  settleVersions,
  stillTrue,
  updateNoticeLine,
  type UpdateChannel,
} from "./update.js";
import { parseSyncState, type SyncState } from "./watermarks.js";

const blank = (): SyncState => ({ lastSyncAt: null, surfaces: {}, scannerRevisions: {} });

describe("compareVersions", () => {
  it.each([
    ["0.6.1", "0.6.1", 0],
    ["0.6.1", "0.6.2", -1],
    ["0.6.10", "0.6.9", 1],
    ["0.10.0", "0.9.9", 1],
    ["1.0.0", "0.99.99", 1],
    ["v0.7.0", "0.7.0", 0],
    ["0.7.0-rc.1", "0.7.0", -1], // a pre-release sorts below its release
    ["0.7.0-rc.2", "0.7.0-rc.10", -1], // numerically, not as text
    ["0.7.0-1", "0.7.0-rc", -1], // numeric identifiers below alphanumeric
    ["0.7.0-rc", "0.7.0-rc.1", -1],
    ["0.7.0+build.5", "0.7.0", 0], // build metadata is ignored
    ["garbage", "0.7.0", 0], // nothing is claimed about what does not parse
  ])("%s vs %s → %i", (a, b, want) => {
    expect(compareVersions(a, b)).toBe(want);
    expect(compareVersions(b, a)).toBe(-want || 0);
  });
});

describe("detectChannel: the copy that runs, and the command that updates it", () => {
  it.each<[string, Record<string, string>, UpdateChannel]>([
    ["/home/j/.claude/plugins/cache/centrail/centrail/0.6.1/scripts/centrail.mjs", {}, "plugin"],
    ["/opt/p/run.mjs", { CLAUDE_PLUGIN_ROOT: "/opt/p" }, "plugin"],
    ["/home/j/.npm/_npx/6a8b/node_modules/centrail/dist/index.js", {}, "npx"],
    ["C:\\Users\\j\\AppData\\Local\\npm-cache\\_npx\\6a8b\\node_modules\\centrail\\dist\\index.js", {}, "npx"],
    ["/home/j/.local/share/mise/installs/npm-centrail/0.6.1/lib/node_modules/centrail/dist/index.js", {}, "mise"],
    ["/usr/local/lib/node_modules/centrail/dist/index.js", {}, "npm-global"],
    ["/home/j/.nvm/versions/node/v22.1.0/lib/node_modules/centrail/dist/index.js", {}, "npm-global"],
    ["C:\\Users\\j\\AppData\\Roaming\\npm\\node_modules\\centrail\\dist\\index.js", {}, "npm-global"],
    ["/home/j/.volta/tools/image/packages/centrail/lib/node_modules/centrail/dist/index.js", {}, "unknown"],
    ["/home/j/project/node_modules/centrail/dist/index.js", {}, "unknown"], // a project dependency
    ["/home/j/src/centrail-cli/packages/cli/dist/index.js", {}, "unknown"],
  ])("%s → %s", (script, env, want) => {
    expect(detectChannel(script, env)).toBe(want);
  });

  it("names one command per channel, and never installs anything itself", () => {
    expect(howToUpdate("plugin")).toBe("it updates through Claude Code (/plugin)");
    expect(howToUpdate("npx")).toContain("npx centrail@latest");
    expect(howToUpdate("mise")).toContain("mise upgrade npm:centrail");
    expect(howToUpdate("npm-global")).toContain("npm i -g centrail@latest");
    expect(howToUpdate("unknown")).toContain("the way you installed it");
    expect(updateNoticeLine({ version: "0.6.1", channel: "npm-global", latest: "0.7.0" })).toBe(
      "centrail 0.7.0 is available (you have 0.6.1): run `npm i -g centrail@latest`.",
    );
    expect(outdatedLine({ version: "0.6.1", channel: "plugin", minimum: "0.7.0" })).toBe(
      "centrail 0.6.1 is older than the server accepts (0.7.0 or newer), so syncing has stopped until it is updated: it updates through Claude Code (/plugin).",
    );
  });
});

describe("the server's word on versions", () => {
  it("reads capabilities `cli` only when its versions parse; anything else is an older server", () => {
    expect(parseCliVersions({ latest: "0.7.0", minimum: "0.1.0" })).toEqual({ latest: "0.7.0", minimum: "0.1.0" });
    expect(parseCliVersions({ minimum: "0.1.0" })).toEqual({ minimum: "0.1.0" }); // npm unreadable: no latest
    expect(parseCliVersions({ latest: 7, minimum: "soon" })).toBeUndefined();
    expect(parseCliVersions(undefined)).toBeUndefined();
    expect(parseCliVersions(["0.7.0"])).toBeUndefined();
  });

  it("a notice while behind, cleared once the same install catches up; another copy's is left alone", () => {
    const state = blank();
    const plugin = { version: "0.6.1", channel: "plugin" as const };
    expect(settleVersions(state, { latest: "0.7.0", minimum: "0.1.0" }, plugin)).toBe(true);
    expect(state.updateNotice).toEqual({ ...plugin, latest: "0.7.0" });
    expect(state.outdated).toBeUndefined();
    // A current `npx` copy says nothing about the plugin's.
    expect(settleVersions(state, { latest: "0.7.0" }, { version: "0.7.0", channel: "npx" })).toBe(false);
    expect(state.updateNotice?.channel).toBe("plugin");
    // The plugin updated: its own sync clears it.
    expect(settleVersions(state, { latest: "0.7.0" }, { version: "0.7.0", channel: "plugin" })).toBe(true);
    expect(state.updateNotice).toBeUndefined();
    // An older server (no `cli`) changes nothing.
    state.updateNotice = { ...plugin, latest: "0.7.0" };
    expect(settleVersions(state, undefined, plugin)).toBe(false);
  });

  it("below the minimum, a park that only this version's hook honors, until the install updates", () => {
    const state = blank();
    const old = { version: "0.6.1", channel: "npm-global" as const };
    settleVersions(state, { minimum: "0.7.0" }, old);
    expect(state.outdated).toEqual({ ...old, minimum: "0.7.0" });
    expect(hookParked(state, "0.6.1")).toBe(true);
    expect(hookParked(state, "0.7.0")).toBe(false); // the updated copy's hook runs
    settleVersions(state, { minimum: "0.7.0" }, { version: "0.7.0", channel: "npm-global" });
    expect(state.outdated).toBeUndefined();
  });

  it("survives state.json round trips, and drops what it cannot read", () => {
    const state = blank();
    settleVersions(state, { latest: "0.7.0", minimum: "0.7.0" }, { version: "0.6.1", channel: "mise" });
    expect(parseSyncState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(parseSyncState({ updateNotice: { version: "x" }, outdated: "yes" })).toEqual(blank());
  });

  it("status repeats another copy's record, and this install's only while it is still behind", () => {
    const notice = { version: "0.6.1", channel: "plugin" as const, latest: "0.7.0" };
    expect(stillTrue(notice, { version: "0.7.0", channel: "npx" }, notice.latest)).toBe(notice);
    expect(stillTrue(notice, { version: "0.6.1", channel: "plugin" }, notice.latest)).toBe(notice);
    expect(stillTrue(notice, { version: "0.7.0", channel: "plugin" }, notice.latest)).toBeUndefined();
    const parked = { version: "0.6.1", channel: "npm-global" as const }; // a 426 with no minimum named
    expect(stillTrue(parked, { version: "0.6.1", channel: "npm-global" }, undefined)).toBe(parked);
    expect(stillTrue(parked, { version: "0.7.0", channel: "npm-global" }, undefined)).toBeUndefined();
  });
});
