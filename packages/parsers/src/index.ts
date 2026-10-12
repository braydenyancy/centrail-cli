import {
  readClaudeCodeAccount,
  scanClaudeCodeLogs,
  type ClaudeCodeAccount,
  type ParsedUsageEvent,
} from "./providers/claude-code.js";
import { scanCopilotLogs } from "./providers/copilot-cli.js";
import { scanCodexLogs } from "./providers/codex.js";
import { scanPiLogs } from "./providers/pi.js";
import { scanGeminiLogs } from "./providers/gemini.js";

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
export { scanPiLogs, piSessionsDir } from "./providers/pi.js";
export { scanGeminiLogs } from "./providers/gemini.js";
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
// registry. New surfaces also require server capability and billing-route
// support; legacy surfaces retain their existing model-derived provider rules.
export type Scanner = {
  surface: string;
  // Increment when a scanner starts discovering previously missed historical
  // events, or when what a re-send carries changes. The CLI uses this to
  // perform one safe full backfill on upgrade: the server dedupes on
  // externalId and keeps the larger count, so it is a re-send, never a row.
  revision: number;
  // New formats require explicit server and consented billing-route support.
  requiresSurfaceCapability?: boolean;
  // `since` selects changed files and their replay candidates.
  // `wholeFiles` returns every event of a file read, those outside `since`
  // marked `metadata.context`: the caller places them with their session,
  // as a full scan would. Sync also sends historical context to recover late
  // imports and growing usage. `onFile` is called after each file (a Copilot
  // session) is read, with the count read and the count `since` left to
  // read, so a caller can show a full scan moving.
  scan: (opts: {
    since?: Date;
    wholeFiles?: boolean;
    onFile?: (done: number, total: number) => void;
  }) => Promise<ParsedUsageEvent[]>;
};

// A discovery/identity repair replays each existing surface once; existing
// stored history is not deleted or repriced. New surfaces have separate marks
// and require a server which understands their billing-route evidence.
export const SCANNERS: Scanner[] = [
  {
    surface: "claude-code",
    revision: 4,
    scan: (opts) => scanClaudeCodeLogs(opts),
  },
  {
    surface: "copilot-cli",
    revision: 3,
    scan: (opts) => scanCopilotLogs({ ...opts, onIssue: (issue) => console.warn(`copilot-cli: quarantined conflicting copy (${issue.externalId})`) }),
  },
  {
    surface: "codex",
    revision: 3,
    scan: (opts) => scanCodexLogs({ ...opts, onIssue: (issue) => console.warn(`codex: quarantined conflicting copy (${issue.externalId})`) }),
  },
  {
    surface: "pi",
    revision: 1,
    requiresSurfaceCapability: true,
    scan: (opts) => scanPiLogs({ ...opts, onIssue: (issue) => console.warn(`pi: quarantined usage (${issue.reason})`) }),
  },
  {
    surface: "gemini-cli",
    revision: 1,
    requiresSurfaceCapability: true,
    scan: (opts) => scanGeminiLogs({ ...opts, onIssue: (issue) => console.warn(`gemini-cli: quarantined usage (${issue.reason})`) }),
  },
];
