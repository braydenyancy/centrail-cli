import { describe, expect, it } from "vitest";
import { assertSecureBaseUrl } from "./url.js";

describe("assertSecureBaseUrl", () => {
  it("accepts https hosts", () => {
    expect(assertSecureBaseUrl("https://centrail.org")).toBe("https://centrail.org");
    expect(assertSecureBaseUrl("https://my-self-host.example.com")).toBe(
      "https://my-self-host.example.com",
    );
  });

  it("allows http only for localhost / loopback (self-host dev)", () => {
    expect(assertSecureBaseUrl("http://localhost:4000")).toBe("http://localhost:4000");
    expect(assertSecureBaseUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(assertSecureBaseUrl("http://[::1]:3000")).toBe("http://[::1]:3000");
  });

  it("rejects http to a remote host (would leak the bearer token)", () => {
    expect(() => assertSecureBaseUrl("http://evil.example.com")).toThrow(/insecure|https/i);
    expect(() => assertSecureBaseUrl("http://centrail.org")).toThrow(/insecure|https/i);
  });

  it("rejects non-http(s) and malformed URLs", () => {
    expect(() => assertSecureBaseUrl("ftp://centrail.org")).toThrow();
    expect(() => assertSecureBaseUrl("not a url")).toThrow(/invalid/i);
  });
});
