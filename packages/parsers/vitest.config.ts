import { defineConfig } from "vitest/config";

// Without this, vitest run from the workspace walks up to the repo root
// config, whose include (src/**/*.test.ts) matches nothing here — and the
// suite silently passes with zero tests.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
