// The per-test budget, by OS: see vitest.config.ts. A test that runs many
// syncs asks for a multiple of it.
export const TEST_TIMEOUT = process.platform === "win32" ? 90_000 : 30_000;
