import { defineConfig } from "vitest/config";

// Most of these tests drive real git and a real sync. On a macOS runner a
// sync over a few fixture repos takes 4-5 s, and a test cut off at vitest's
// default 5 s leaves its sync holding the machine lock, so every later test
// in the file reads "another sync is already running" and fails with it.
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
