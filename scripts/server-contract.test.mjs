import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SCANNERS } from "../packages/parsers/dist/index.js";

const exporter = fileURLToPath(new URL("./export-scanner-surfaces.mjs", import.meta.url));
const checker = fileURLToPath(new URL("./check-server-contract.mjs", import.meta.url));

function run(script, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, GITHUB_OUTPUT: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function exported(mode) {
  const dir = await mkdtemp(join(tmpdir(), "centrail-contract-"));
  try {
    const output = join(dir, "outputs.txt");
    const result = await run(exporter, [mode], { GITHUB_OUTPUT: output });
    assert.equal(result.code, 0, result.stderr);
    return Object.fromEntries((await readFile(output, "utf8")).trimEnd().split("\n")
      .map((line) => line.split("=")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("main requires exactly unconditional scanners; publication includes gated scanners and their field", async () => {
  const required = await exported("required");
  const all = await exported("all");
  assert.equal(required.surfaces, SCANNERS.filter((s) => !s.requiresSurfaceCapability).map((s) => s.surface).join(","));
  assert.equal(required.fields, "");
  assert.equal(all.surfaces, SCANNERS.map((s) => s.surface).join(","));
  assert.equal(all.fields, "billing-route");
  assert.ok(all.surfaces.includes("pi"));
  assert.ok(all.surfaces.includes("gemini-cli"));
  const invalid = await run(exporter, ["typo"]);
  assert.notEqual(invalid.code, 0);
});

test("real contract command fails closed against synthetic local servers", async (t) => {
  const required = await exported("required");
  const all = await exported("all");
  const oldServer = { wireVersions: ["1"], surfaces: required.surfaces.split(",") };
  const fullServer = { wireVersions: ["1"], surfaces: all.surfaces.split(","), fields: ["billing-route"] };
  const cases = [
    { name: "main accepts old server with gated scanners absent", policy: required, body: oldServer, success: true },
    { name: "main rejects missing unconditional surface", policy: required, body: { ...oldServer, surfaces: [] }, error: /does not accept surfaces/ },
    { name: "publication rejects missing gated scanners", policy: all, body: oldServer, error: /does not accept surfaces: pi, gemini-cli/ },
    { name: "publication rejects surfaces without billing route support", policy: all, body: { ...fullServer, fields: [] }, error: /does not accept fields: billing-route/ },
    { name: "publication accepts all surfaces and required fields", policy: all, body: fullServer, success: true },
    { name: "main rejects incompatible wire version", policy: required, body: { ...oldServer, wireVersions: ["2"] }, error: /does not accept wire version 1/ },
    { name: "main rejects malformed capabilities", policy: required, body: {}, error: /does not accept wire version 1/ },
    { name: "main rejects unavailable endpoint", policy: required, status: 503, body: {}, error: /server contract request failed: 503/ },
    { name: "empty expected surfaces fail closed", policy: { surfaces: "", fields: "" }, body: fullServer, error: /must contain at least one surface/ },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const server = createServer((_request, response) => {
        response.writeHead(fixture.status ?? 200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(fixture.body));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const result = await run(checker, [], {
          CENTRAIL_CONTRACT_URL: `http://127.0.0.1:${server.address().port}/capabilities`,
          CENTRAIL_CONTRACT_ATTEMPTS: "1",
          CENTRAIL_WIRE_VERSION: "1",
          CENTRAIL_EXPECTED_SURFACES: fixture.policy.surfaces,
          CENTRAIL_EXPECTED_FIELDS: fixture.policy.fields,
        });
        if (fixture.success) assert.equal(result.code, 0, result.stderr);
        else {
          assert.notEqual(result.code, 0);
          assert.match(result.stderr, fixture.error);
        }
      } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    });
  }
});
