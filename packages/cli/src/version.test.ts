import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_VERSION, WIRE_VERSION, versionHeaders } from "./version.js";

describe("version headers", () => {
  it("exposes a semver CLI version and integer wire version", () => {
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(WIRE_VERSION).toBe("1");
  });

  it("matches package.json — the constant drifted to 0.1.0 once already", () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
    ) as { version: string };
    expect(CLI_VERSION).toBe(pkg.version);
  });

  it("builds the header pair the server reads", () => {
    expect(versionHeaders()).toEqual({
      "centrail-cli-version": CLI_VERSION,
      "centrail-wire": WIRE_VERSION,
    });
  });
});
