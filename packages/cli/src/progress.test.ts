import { afterEach, describe, expect, it } from "vitest";
import { progressEnabled, setProgressMode } from "./progress.js";

afterEach(() => setProgressMode("auto"));

describe("progressEnabled", () => {
  it("shows progress only to a person at a terminal by default", () => {
    expect(progressEnabled({}, true)).toBe(true);
    expect(progressEnabled({}, false)).toBe(false); // the hook's detached sync, an agent's pipe
    expect(progressEnabled({ CI: "true" }, true)).toBe(false);
  });

  it("--verbose forces it on and --quiet off", () => {
    setProgressMode("verbose");
    expect(progressEnabled({ CI: "true" }, false)).toBe(true);
    setProgressMode("quiet");
    expect(progressEnabled({}, true)).toBe(false);
  });
});
