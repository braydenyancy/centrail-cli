import { defineConfig } from "vitest/config";
import { TEST_TIMEOUT } from "./src/testing/timeout.js";

// Most of these tests drive real git and a real sync. A macOS runner takes
// 4-5 s for a sync over a few fixture repos and Windows up to 25 s (a git
// spawn costs far more there). A test cut off early leaves its sync holding
// the machine lock, so every later test in the file reads "another sync is
// already running" and fails with it.
export default defineConfig({
  test: {
    testTimeout: TEST_TIMEOUT,
  },
});
