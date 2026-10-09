// Optional real-executable comparison. Pins and reviewed differences live in
// tools/tokscale-compare; unavailable tools or isolation fail, never pass as an
// empty comparison. The suite reads checked-in fixtures only and never fetches.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const enabled = process.env.CENTRAIL_CONTROL === "1";
const suite = fileURLToPath(new URL("../../../tools/tokscale-compare/suite.py", import.meta.url));

describe.skipIf(!enabled)("pinned coding-tool comparison suite", () => {
  it("matches source oracles and explicitly reviewed competitor observations", () => {
    execFileSync("python3", [suite], { encoding: "utf-8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  }, 130_000);
});
