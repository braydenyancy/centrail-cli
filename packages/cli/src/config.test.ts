import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordNode } from "./config.js";

describe("recordNode", () => {
  it("records the Node a terminal ran, and rewrites it only when it changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "centrail-node-"));
    const file = join(dir, "sub", "node");
    await recordNode("/a/node", file);
    expect(await readFile(file, "utf-8")).toBe("/a/node\n");
    const first = (await stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await recordNode("/a/node", file);
    expect((await stat(file)).mtimeMs).toBe(first);
    await recordNode("/b/node", file);
    expect(await readFile(file, "utf-8")).toBe("/b/node\n");
    await rm(dir, { recursive: true, force: true });
  });
});
