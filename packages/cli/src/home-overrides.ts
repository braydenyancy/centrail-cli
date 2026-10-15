// Agent homes that replace the defaults (commands/agent-hooks.ts defaultHome).
// Only the test setup (testing/agent-homes.ts) fills it: Cursor reads no
// variable for its home, so no environment variable can point it at scratch.
// Dependency-free on purpose: the setup file imports it before any test
// module, and anything it imported would be evaluated before the test's own
// environment (CENTRAIL_CONFIG_DIR) is set.
export const homeOverrides: Record<string, string | undefined> = {};
