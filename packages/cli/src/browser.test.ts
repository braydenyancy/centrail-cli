import { describe, expect, it } from "vitest";
import { browserCommand, openBrowser, shouldOpenBrowser } from "./browser.js";

const URL_ = "https://centrail.org/connect?code=ABCD-EFGH";

describe("shouldOpenBrowser", () => {
  it.each([
    ["a desktop terminal", { DISPLAY: ":0" }, true, "linux", true],
    ["a Wayland session", { WAYLAND_DISPLAY: "wayland-0" }, true, "linux", true],
    ["macOS", {}, true, "darwin", true],
    ["Windows", {}, true, "win32", true],
    ["WSL", { WSL_DISTRO_NAME: "Ubuntu" }, true, "linux", true],
    ["piped output (an agent)", { DISPLAY: ":0" }, false, "linux", false],
    ["CI", { DISPLAY: ":0", CI: "true" }, true, "linux", false],
    ["an SSH session", { DISPLAY: ":0", SSH_CONNECTION: "1 2 3 4" }, true, "linux", false],
    ["a headless Linux box", {}, true, "linux", false],
  ] as const)("%s → %s", (_name, env, isTTY, platform, expected) => {
    expect(shouldOpenBrowser(env, isTTY, platform)).toBe(expected);
  });
});

describe("browserCommand", () => {
  it("uses the platform's own opener, and BROWSER when set", () => {
    expect(browserCommand(URL_, {}, "darwin")).toEqual(["open", [URL_]]);
    expect(browserCommand(URL_, {}, "linux")).toEqual(["xdg-open", [URL_]]);
    expect(browserCommand(URL_, { WSL_DISTRO_NAME: "Ubuntu" }, "linux")).toEqual(["wslview", [URL_]]);
    expect(browserCommand(URL_, {}, "win32")).toEqual(["rundll32", ["url.dll,FileProtocolHandler", URL_]]);
    expect(browserCommand(URL_, { BROWSER: "firefox:chromium" }, "linux")).toEqual(["firefox", [URL_]]);
  });
});

describe("openBrowser", () => {
  it("never opens a page on another origin than the server it pairs with", () => {
    expect(openBrowser("https://evil.example/connect", "https://centrail.org")).toBe(false);
    expect(openBrowser("not a url", "https://centrail.org")).toBe(false);
  });
});
