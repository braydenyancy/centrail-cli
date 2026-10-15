import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeOverrides } from "../home-overrides.js";

// Every test process points the agents centrail detects by their own
// variables at a scratch path that does not exist, so no test can read or
// write the real ~/.gemini, ~/.copilot, ~/.pi, ~/.cursor or ~/.config/opencode
// even when it forgets to pass a home. Cursor reads no variable for its home,
// so the defaults themselves are redirected (homeOverrides). Tests that need one
// pass it in IntegrationDeps.

const scratch = join(tmpdir(), `centrail-test-agent-homes-${process.pid}`);
process.env.GEMINI_CLI_HOME = join(scratch, "gemini-home");
process.env.COPILOT_HOME = join(scratch, "copilot");
process.env.PI_CODING_AGENT_DIR = join(scratch, "pi-agent");
homeOverrides.cursor = join(scratch, "cursor");
homeOverrides.opencode = join(scratch, "opencode");
