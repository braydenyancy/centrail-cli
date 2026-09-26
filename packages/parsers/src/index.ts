import {
  readClaudeCodeAccount,
  scanClaudeCodeLogs,
  type ClaudeCodeAccount,
  type ParsedUsageEvent,
} from "./providers/claude-code.js";
import { scanCopilotLogs } from "./providers/copilot-cli.js";
import { scanCodexLogs } from "./providers/codex.js";

export {
  collapseUsageEvents,
  readClaudeCodeAccount,
  scanClaudeCodeLogs,
  claudeConfigDirs,
  claudeProjectDirs,
  type ClaudeCodeAccount,
  type ParsedUsageEvent,
  type RepoIdentity,
} from "./providers/claude-code.js";

export { scanCopilotLogs } from "./providers/copilot-cli.js";
export {
  codexHomeDir,
  codexHomeDirs,
  codexSessionsDir,
  scanCodexLogs,
} from "./providers/codex.js";

export {
  matchEventsToCommits,
  parseGitLogNumstat,
  type AttributionEvent,
  type EventAttribution,
  type RepoCommit,
} from "./providers/git-attribution.js";

export {
  computeCommitFates,
  UNSHIPPED_AFTER_DAYS,
  type CommitFate,
  type CommitFateRow,
  type ShipStatusFacts,
} from "./providers/ship-status.js";

// A surface is one tool whose local logs we read. The CLI iterates this
// registry; the server derives provider from each event's model. Adding a
// surface = one entry here + its scanner module.
export type Scanner = {
  surface: string;
  // Increment when a scanner starts discovering previously missed historical
  // events. The CLI uses this to perform one safe full backfill on upgrade.
  revision: number;
  scan: (opts: { since?: Date }) => Promise<ParsedUsageEvent[]>;
};

export const SCANNERS: Scanner[] = [
  {
    surface: "claude-code",
    revision: 2,
    scan: (opts) => scanClaudeCodeLogs(opts),
  },
  {
    surface: "copilot-cli",
    revision: 1,
    scan: (opts) => scanCopilotLogs(opts),
  },
  {
    surface: "codex",
    revision: 1,
    scan: (opts) => scanCodexLogs(opts),
  },
];
