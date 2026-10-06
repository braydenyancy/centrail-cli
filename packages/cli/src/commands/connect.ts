import { readdir } from "node:fs/promises";
import { claudeProjectDirs } from "@centrail/parsers";
import { writeAuth } from "../config.js";
import { runSetup } from "./scope.js";
import { versionHeaders } from "../version.js";
import { assertSecureBaseUrl } from "../url.js";

const DEFAULT_BASE_URL = "https://centrail.org";
export const PRIVATE_DEVICE_NAME = "Centrail CLI";

type PairResponse = {
  code: string;
  pollToken: string;
  verificationUrl: string;
  interval: number;
  expiresIn: number;
};

type PollResponse = { status: string; token?: string };

export async function runConnect(opts: { baseUrl?: string }): Promise<void> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  assertSecureBaseUrl(baseUrl);

  const res = await fetch(`${baseUrl}/api/cli/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", ...versionHeaders() },
    // The current server calls this field hostname, but it is only a display
    // label. Never send the operating-system hostname or other fingerprinting
    // data during pairing.
    body: JSON.stringify({ hostname: PRIVATE_DEVICE_NAME }),
  });
  if (!res.ok) {
    throw new Error(
      `Pairing request failed (${res.status}) — is ${baseUrl} reachable?`,
    );
  }
  const pair = (await res.json()) as PairResponse;

  console.log("");
  console.log(`  Visit:  ${pair.verificationUrl}`);
  console.log(`  Code:   ${pair.code}`);
  console.log("");
  console.log("  Waiting for authorization...");

  const deadline = Date.now() + pair.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(pair.interval * 1000);

    let poll: Response;
    try {
      poll = await fetch(`${baseUrl}/api/cli/pair/poll`, {
        method: "POST",
        headers: { "content-type": "application/json", ...versionHeaders() },
        body: JSON.stringify({ pollToken: pair.pollToken }),
      });
    } catch {
      continue; // transient network error — keep polling until the deadline
    }
    if (!poll.ok) continue;

    const body = (await poll.json()) as PollResponse;
    if (body.status === "approved" && body.token) {
      await writeAuth({
        baseUrl,
        token: body.token,
        deviceName: PRIVATE_DEVICE_NAME,
      });
      console.log(`  ✓ Paired (${PRIVATE_DEVICE_NAME})`);
      await reportDetectedLogs();
      console.log(FIELDS_SHOWN_ONCE);
      await runSetup({ interactive: process.stdin.isTTY === true });
      console.log("");
      console.log("  Run `npx centrail sync` to push usage, and `npx centrail install-hooks`");
      console.log("  so Claude Code syncs by itself after each turn.");
      return;
    }
    if (body.status === "expired") {
      throw new Error(
        "Pairing expired or was already used — run `centrail connect` again",
      );
    }
  }
  throw new Error("Pairing timed out — run `centrail connect` again");
}

async function reportDetectedLogs(): Promise<void> {
  const dirs = claudeProjectDirs();
  const found: string[] = [];
  let total = 0;
  for (const dir of dirs) {
    try {
      const entries = await readdir(dir);
      found.push(dir);
      total += entries.length;
    } catch {
      // missing dir — skip
    }
  }
  if (found.length > 0) {
    console.log(
      `  ✓ Found Claude Code logs: ${found.join(", ")} (${total} project folders)`,
    );
  } else {
    console.log(
      `  ⚠ No Claude Code logs found (looked in ${dirs.join(", ")}) — nothing to sync yet.`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shown once, at pairing: the complete list of what sync sends. Kept in step
// with toWireEvent (wire.ts) — that function is the policy, this is its
// summary. `centrail inspect --last` prints the real payload any time.
const FIELDS_SHOWN_ONCE = `
  What leaves this machine on each sync — and nothing else:
    tokens per model, timestamps, the agent and CLI version, session id,
    repo identity (host/owner/repo or a root-commit hash), folder name,
    branch, commit shas and line counts, a random per-install id.
  Never: source, prompts, completions, secrets, paths, hostname, platform,
  account details.
  Verify any time:  npx centrail inspect --last
  Toggles in ~/.config/centrail/config.json: hideRepoNames, hideBranchNames.
`;
