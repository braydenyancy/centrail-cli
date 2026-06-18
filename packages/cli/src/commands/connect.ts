import { readdir } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { writeAuth } from "../config.js";
import { versionHeaders } from "../version.js";

const DEFAULT_BASE_URL = "https://centrail.org";

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

  const res = await fetch(`${baseUrl}/api/cli/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", ...versionHeaders() },
    body: JSON.stringify({ hostname: hostname(), platform: platform() }),
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
        deviceName: hostname(),
      });
      console.log(`  ✓ Paired (this machine: ${hostname()})`);
      await reportDetectedLogs();
      console.log("  Run `npx centrail sync` to push usage.");
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
  const dir = join(homedir(), ".claude", "projects");
  try {
    const entries = await readdir(dir);
    console.log(
      `  ✓ Found Claude Code logs: ~/.claude/projects (${entries.length} project folders)`,
    );
  } catch {
    console.log(
      "  ⚠ No Claude Code logs found at ~/.claude/projects — nothing to sync yet.",
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
