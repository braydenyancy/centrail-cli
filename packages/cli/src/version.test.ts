import { describe, expect, it } from "vitest";
import { CLI_VERSION, WIRE_VERSION, versionHeaders } from "./version.js";

describe("version headers", () => {
  it("exposes a semver CLI version and integer wire version", () => {
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(WIRE_VERSION).toBe("1");
  });

  it("builds the header pair the server reads", () => {
    expect(versionHeaders()).toEqual({
      "centrail-cli-version": CLI_VERSION,
      "centrail-wire": WIRE_VERSION,
    });
  });
});
