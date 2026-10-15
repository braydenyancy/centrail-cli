import { disconnectedMessage, parkAuth, readAuth, readDisconnected, readState } from "../config.js";
import { checkDevice } from "../device.js";
import { copyLabel, here, liveVersionRecords, outdatedLine, updateNoticeLine } from "../update.js";
import { installedPluginVersion } from "./integrations.js";

// Which account this machine syncs to, asked of the server, so two people or
// two accounts on one machine can tell before a sync goes anywhere. Exits 1
// when there is nothing to sync to, as `gh auth status` does.
export async function runStatus(): Promise<void> {
  const auth = await readAuth();
  if (!auth) {
    const parked = await readDisconnected();
    console.log(parked ? disconnectedMessage(parked) : "Not connected. Run `npx centrail connect` to pair this machine.");
    process.exitCode = 1;
    return;
  }
  const device = await checkDevice(auth);
  if (device.kind === "refused") {
    await parkAuth(device.reason);
    console.log(disconnectedMessage({ at: new Date().toISOString(), reason: device.reason }));
    process.exitCode = 1;
    return;
  }
  const host = new URL(auth.baseUrl).host;
  const email = (device.kind === "active" ? device.account?.email : undefined) ?? auth.account?.email;
  const paired = device.kind === "active" && device.pairedAt ? ` · paired ${device.pairedAt.slice(0, 10)}` : "";
  const unconfirmed = device.kind === "unknown" ? " (the server could not confirm it just now)" : "";
  console.log(`Connected to ${host}${email ? ` as ${email}` : ""}${paired}${unconfirmed}`);
  await printVersionRecords();
}

// What the last syncs learned about the CLI's version (update.ts): a hook's
// background sync has no terminal to say it in, so it is said here. A
// record this install, or Claude Code's plugin update, has outgrown since is
// not repeated.
async function printVersionRecords(): Promise<void> {
  const state = await readState();
  const at = here();
  console.log(`This command ran centrail ${at.version} (${copyLabel(at.channel)}).`);
  // The plugin's version as Claude Code installed it: a record about an
  // older plugin copy is not repeated once Claude Code has updated it.
  const { outdated, notice } = liveVersionRecords(state, at, await installedPluginVersion());
  // Saved by whichever copy last synced, often the plugin's hook: name it.
  if (outdated) console.log(`${copyLabel(outdated.channel)}: ${outdatedLine(outdated)}`);
  if (notice) console.log(`${copyLabel(notice.channel)}: ${updateNoticeLine(notice)}`);
}
