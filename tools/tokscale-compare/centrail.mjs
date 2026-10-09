import { scanCopilotLogs } from '/parsers/providers/copilot-cli.js';
import { scanClaudeCodeLogs } from '/parsers/providers/claude-code.js';
import { scanCodexLogs } from '/parsers/providers/codex.js';
import { scanPiLogs } from '/parsers/providers/pi.js';
import { scanGeminiLogs } from '/parsers/providers/gemini.js';
const client = process.argv[2];
const scanners = {
  copilot: [scanCopilotLogs, '/fixtures/.copilot/session-state'],
  claude: [scanClaudeCodeLogs, '/fixtures/.claude/projects'],
  codex: [scanCodexLogs, '/fixtures/.codex/sessions'],
  pi: [scanPiLogs, '/fixtures/.pi/agent/sessions'],
  gemini: [scanGeminiLogs, '/fixtures/.gemini/tmp'],
};
if (!Object.hasOwn(scanners, client)) throw new Error('Explicit supported client required');
const [scan, basePath] = scanners[client];
const issues = [];
// Exercise Codex's actual live/archive root discovery, confined to fixture mounts.
if (client === 'codex') process.env.CODEX_HOME = '/fixtures/.codex';
const records = await scan({ ...(client === 'codex' ? {} : { basePath }), onIssue: (issue) => issues.push(issue) });
console.log(JSON.stringify({ schemaVersion: 1, client, records, issues }));
