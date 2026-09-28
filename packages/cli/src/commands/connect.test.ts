import { afterEach, describe, expect, it, vi } from "vitest";
import { PRIVATE_DEVICE_NAME, runConnect } from "./connect.js";

describe("runConnect privacy boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a generic label and sends no machine fingerprint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "stop after request" }), { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(runConnect({ baseUrl: "https://centrail.org" })).rejects.toThrow(
      "Pairing request failed",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://centrail.org/api/cli/pair");
    expect(JSON.parse(init.body as string)).toEqual({
      hostname: PRIVATE_DEVICE_NAME,
    });
    expect(init.body).not.toContain(process.env.HOSTNAME ?? "__missing_hostname__");
    expect(init.body).not.toContain(process.platform);
  });
});
