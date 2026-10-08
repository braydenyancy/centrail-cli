// The CLI bundle, and the plugin's copy of it. A script rather than
// `rm -rf … && esbuild … && cp …` because npm runs package scripts under
// cmd.exe on Windows, which has neither `rm` nor `cp`.
import { copyFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const at = (p) => fileURLToPath(new URL(p, import.meta.url));

rmSync(at("../dist"), { recursive: true, force: true });
await build({
  absWorkingDir: at(".."),
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  alias: { "@centrail/parsers": "../parsers/src/index.ts" },
  outfile: "dist/index.js",
  logLevel: "warning",
});
copyFileSync(at("../dist/index.js"), at("../../../plugins/centrail/scripts/centrail.mjs"));
