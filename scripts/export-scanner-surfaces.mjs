import { appendFileSync } from "node:fs";
import { SCANNERS } from "../packages/parsers/dist/index.js";

const mode = process.argv[2] ?? "all";
if (!["all", "required"].includes(mode)) {
  throw new Error(`unknown scanner contract mode: ${mode}`);
}
const scanners = mode === "required"
  ? SCANNERS.filter((scanner) => !scanner.requiresSurfaceCapability)
  : SCANNERS;
const surfaces = scanners.map((scanner) => scanner.surface).join(",");
const fields = scanners.some((scanner) => scanner.requiresSurfaceCapability)
  ? "billing-route" : "";
const output = process.env.GITHUB_OUTPUT;

if (!output) {
  process.stdout.write(`${surfaces}\n`);
} else {
  appendFileSync(output, `surfaces=${surfaces}\nfields=${fields}\n`);
}
