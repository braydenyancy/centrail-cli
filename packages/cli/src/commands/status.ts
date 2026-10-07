import { disconnectedMessage, parkAuth, readAuth, readDisconnected, readState } from "../config.js";
import { checkDevice } from "../device.js";
import { here, outdatedLine, sameInstall, stillTrue, updateNoticeLine } from "../update.js";

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
// record this install has outgrown since is not repeated.
async function printVersionRecords(): Promise<void> {
  const state = await readState();
  const at = here();
  const outdated = stillTrue(state.outdated, at, state.outdated?.minimum);
  const notice = stillTrue(state.updateNotice, at, state.updateNotice?.latest);
  if (outdated) console.log(outdatedLine(outdated));
  if (notice && !(outdated && sameInstall(notice, outdated))) console.log(updateNoticeLine(notice));
}
