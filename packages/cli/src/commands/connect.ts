import { readdir } from "node:fs/promises";
import { claudeProjectDirs } from "@centrail/parsers";
import { readAuth, readConfig, readState, writeAuth, writeState } from "../config.js";
import { openBrowser, shouldOpenBrowser } from "../browser.js";
import { offerPlugin, type PluginSetupDeps } from "./plugin-setup.js";
import { isInteractiveTerminal, runSetup } from "./scope.js";
import { CLI_VERSION, versionHeaders } from "../version.js";
import { here, howToUpdate, minimumFrom } from "../update.js";
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

type PollResponse = { status: string; token?: string; account?: { email?: unknown } };

export async function runConnect(opts: { baseUrl?: string; noBrowser?: boolean }, pluginDeps: PluginSetupDeps = {}): Promise<void> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  assertSecureBaseUrl(baseUrl);

  // One machine holds one pairing (auth.json). Approving in the browser is
  // the confirmation: the approve page says when this machine is paired to
  // another account and what moving it means.
  const previous = await readAuth();
  if (previous) {
    console.log("");
    console.log(`  This machine is paired${previous.account ? ` with ${previous.account.email}` : ""}. Approving below re-pairs it;`);
    console.log("  approve as another account and it moves there: what it synced stays with the old account,");
    console.log("  and its usage from now on goes to the new one.");
  }

  // The install id lets the server replace this machine's own device in
  // place, or move it between accounts, instead of pairing a stranger. It is
  // a consented field (decision § 3.7): sent only once this install has
  // answered the scope question. A first pairing has no device to replace,
  // and the server learns the id from the first consented sync.
  const config = await readConfig();
  const installId = config.scopeDecidedAt && config.installId ? config.installId : undefined;

  const res = await fetch(`${baseUrl}/api/cli/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", ...versionHeaders() },
    // The current server calls this field hostname, but it is only a display
    // label. Never send the operating-system hostname or other fingerprinting
    // data during pairing.
    body: JSON.stringify({ hostname: PRIVATE_DEVICE_NAME, ...(installId ? { installId } : {}) }),
  });
  if (res.status === 426) {
    const minimum = await minimumFrom(res);
    throw new Error(`centrail ${CLI_VERSION} is older than ${new URL(baseUrl).host} pairs with${minimum ? ` (${minimum} or newer)` : ""}: ${howToUpdate(here().channel)}.`);
  }
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
  if (!opts.noBrowser && shouldOpenBrowser() && openBrowser(pair.verificationUrl, baseUrl)) {
    console.log("  Opened in your browser. Check the code matches, then approve.");
  }
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
      const email = typeof body.account?.email === "string" && body.account.email ? body.account.email : undefined;
      await writeAuth({
        baseUrl,
        token: body.token,
        deviceName: PRIVATE_DEVICE_NAME,
        ...(email ? { account: { email } } : {}),
      });
      if (!email || previous?.account?.email !== email) await forgetWatermarks();
      console.log(email ? `  ✓ Paired with ${email}` : `  ✓ Paired (${PRIVATE_DEVICE_NAME})`);
      if (email && previous?.account?.email && previous.account.email !== email) {
        console.log(`  What this machine synced to ${previous.account.email} stays there; ${email} gets everything else.`);
      }
      await reportDetectedLogs();
      console.log(FIELDS_SHOWN_ONCE);
      await runSetup({ interactive: process.stdin.isTTY === true });
      await offerPlugin({ interactive: isInteractiveTerminal() }, pluginDeps);
      console.log("");
      console.log("  Run `npx centrail sync` to push usage now. Codex, or Claude Code without the plugin:");
      console.log("  `npx centrail install-hooks` syncs after each turn.");
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

// Watermarks belong to the machine, not the account (state.json). Forgotten
// whenever the account may have changed, so the first sync after re-reads
// everything once. One provider event, one account (decision A, 2026-10-07):
// the server keeps an event with the account that synced it first, skips it
// for any other and counts it as `heldElsewhere`, so the old account keeps
// its history and the new one gets only what no account holds. Re-sending to
// the same account costs a rescan, never a duplicate.
async function forgetWatermarks(): Promise<void> {
  const state = await readState();
  if (Object.keys(state.surfaces).length === 0 && !state.lastSyncAt) return;
  state.surfaces = {};
  state.lastSyncAt = null;
  await writeState(state);
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
// with toWireEvent and toWireFate (wire.ts) — they are the policy, this is its
// summary. `centrail inspect --last` prints the real payload any time.
const FIELDS_SHOWN_ONCE = `
  What leaves this machine on each sync — and nothing else:
    tokens per model, timestamps, the agent and CLI version, session id,
    repo identity (host/owner/repo or a root-commit hash), folder name,
    branch, commit shas, line counts and change hashes (git patch-id),
    a random per-install id.
  Never: source, prompts, completions, secrets, paths, hostname, platform,
  account details.
  Verify any time:  npx centrail inspect --last
  Toggles in ~/.config/centrail/config.json: hideRepoNames, hideBranchNames.
`;
