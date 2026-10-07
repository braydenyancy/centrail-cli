import { disconnectedMessage, parkAuth, readAuth, readDisconnected } from "../config.js";
import { checkDevice } from "../device.js";

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
}
