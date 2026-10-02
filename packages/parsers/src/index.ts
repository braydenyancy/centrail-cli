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
  lineEvidence,
  readClaudeCodeAccount,
  scanClaudeCodeLogs,
  claudeConfigDirs,
  claudeProjectDirs,
  TurnCounter,
  type ClaudeCodeAccount,
  type ParsedUsageEvent,
  type Placement,
  type RepoIdentity,
} from "./providers/claude-code.js";

export {
  bashPaths,
  claudeToolEvidence,
  codexCallEvidence,
  mergeEvidence,
  type Evidence,
} from "./providers/evidence.js";

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
  // events, or when what a re-send carries changes. The CLI uses this to
  // perform one safe full backfill on upgrade: the server dedupes on
  // externalId and keeps the larger count, so it is a re-send, never a row.
  revision: number;
  scan: (opts: { since?: Date }) => Promise<ParsedUsageEvent[]>;
};

// 0.6.0 bumps every surface once (claude-code 2→3, copilot-cli and codex
// 1→2): each install re-sends its whole history, and to a server that lists
// "repo" those events carry the § 3.10 identity metadata 0.5.1 never sent,
// so the server can fill it into the rows it already holds.
export const SCANNERS: Scanner[] = [
  {
    surface: "claude-code",
    revision: 3,
    scan: (opts) => scanClaudeCodeLogs(opts),
  },
  {
    surface: "copilot-cli",
    revision: 2,
    scan: (opts) => scanCopilotLogs(opts),
  },
  {
    surface: "codex",
    revision: 2,
    scan: (opts) => scanCodexLogs(opts),
  },
];
