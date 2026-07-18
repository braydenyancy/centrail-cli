import { appendFileSync } from "node:fs";
import { SCANNERS } from "../packages/parsers/dist/index.js";

const surfaces = SCANNERS.map((scanner) => scanner.surface).join(",");
const output = process.env.GITHUB_OUTPUT;

if (!output) {
  process.stdout.write(`${surfaces}\n`);
} else {
  appendFileSync(output, `surfaces=${surfaces}\n`);
}
