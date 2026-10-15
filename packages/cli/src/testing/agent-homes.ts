import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test process points the agents centrail detects by their own
// variables at a scratch path that does not exist, so no test can read or
// write the real ~/.gemini, ~/.copilot or ~/.pi even when it forgets to pass
// a home. Tests that need one pass it in IntegrationDeps.
const scratch = join(tmpdir(), `centrail-test-agent-homes-${process.pid}`);
process.env.GEMINI_CLI_HOME = join(scratch, "gemini-home");
process.env.COPILOT_HOME = join(scratch, "copilot");
process.env.PI_CODING_AGENT_DIR = join(scratch, "pi-agent");
