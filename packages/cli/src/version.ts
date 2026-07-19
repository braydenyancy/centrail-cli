// Keep CLI_VERSION in sync with packages/cli/package.json "version".
// (The esbuild bundle has no package.json at runtime, so this is a constant.)
export const CLI_VERSION = "0.4.1";

// Wire contract version — bump only on a BREAKING payload change. The server
// supports the current and previous contract versions (see CONTRACT.md).
export const WIRE_VERSION = "1";

export function versionHeaders(): Record<string, string> {
  return {
    "centrail-cli-version": CLI_VERSION,
    "centrail-wire": WIRE_VERSION,
  };
}
