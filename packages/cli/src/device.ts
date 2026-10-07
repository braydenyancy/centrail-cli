import type { AuthConfig, DisconnectReason } from "./config.js";
import { versionHeaders } from "./version.js";

export type DeviceStatus =
  | { kind: "active"; account?: { email: string }; pairedAt?: string }
  | { kind: "refused"; reason: DisconnectReason }
  | { kind: "unknown" };

// Asks the server whether this machine's token still works before a sync
// spends minutes scanning, and before "No new events" can read as healthy on
// a machine whose pairing is gone. A server older than GET /api/cli/device
// (404), an outage or a timeout is "unknown": the sync goes on exactly as
// before, and ingest's own 401 still catches a dead token.
export async function checkDevice(auth: Pick<AuthConfig, "baseUrl" | "token">): Promise<DeviceStatus> {
  try {
    const res = await fetch(`${auth.baseUrl}/api/cli/device`, {
      headers: { authorization: `Bearer ${auth.token}`, ...versionHeaders() },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401) return { kind: "refused", reason: await refusalReason(res) };
    if (!res.ok) return { kind: "unknown" };
    const body = (await res.json()) as { account?: { email?: unknown }; device?: { pairedAt?: unknown } };
    const email = body.account?.email;
    const pairedAt = body.device?.pairedAt;
    return {
      kind: "active",
      ...(typeof email === "string" && email ? { account: { email } } : {}),
      ...(typeof pairedAt === "string" ? { pairedAt } : {}),
    };
  } catch {
    return { kind: "unknown" };
  }
}

// The server's 401 body names the reason (CONTRACT.md); older servers send
// only the error string.
export async function refusalReason(res: Response): Promise<DisconnectReason> {
  const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
  return body?.code === "device_revoked" || body?.code === "unknown_token" ? body.code : "unauthorized";
}
