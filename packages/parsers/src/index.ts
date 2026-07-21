import {
  readClaudeCodeAccount,
  scanClaudeCodeLogs,
  type ClaudeCodeAccount,
  type ParsedUsageEvent,
} from "./providers/claude-code.js";
import { scanCopilotLogs } from "./providers/copilot-cli.js";
import { scanCodexLogs } from "./providers/codex.js";

export {
  readClaudeCodeAccount,
  scanClaudeCodeLogs,
  claudeConfigDirs,
  claudeProjectDirs,
  type ClaudeCodeAccount,
  type ParsedUsageEvent,
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
  scan: (opts: { since?: Date }) => Promise<ParsedUsageEvent[]>;
  readAccount?: () => Promise<ClaudeCodeAccount | null>;
};

export const SCANNERS: Scanner[] = [
  {
    surface: "claude-code",
    scan: (opts) => scanClaudeCodeLogs(opts),
    readAccount: () => readClaudeCodeAccount(),
  },
  {
    surface: "copilot-cli",
    scan: (opts) => scanCopilotLogs(opts),
  },
  {
    surface: "codex",
    scan: (opts) => scanCodexLogs(opts),
  },
];
