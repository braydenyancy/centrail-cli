import { spawn } from "node:child_process";

type Env = Record<string, string | undefined>;

// `connect` opens the approval page at once, as `wrangler login` does: the
// CLI is already polling, so there is nothing to wait for. The URL is printed
// either way, for whoever the browser cannot reach. Never where no one is
// looking: piped output (an agent running `connect`), CI, an SSH session
// (the browser would open on the far machine), a Linux session with no
// display. Zero dependencies: the platform's own opener, detached, its
// failure ignored.
export function shouldOpenBrowser(
  env: Env = process.env,
  isTTY = process.stdout.isTTY === true,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!isTTY || env.CI || env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.WSL_DISTRO_NAME) return false;
  return true;
}

export function browserCommand(
  url: string,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): [string, string[]] {
  const chosen = env.BROWSER?.split(":")[0]?.trim();
  if (chosen) return [chosen, [url]];
  if (platform === "darwin") return ["open", [url]];
  // rundll32 takes the URL as one argument: no shell, so no `&` quoting.
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  if (env.WSL_DISTRO_NAME) return ["wslview", [url]];
  return ["xdg-open", [url]];
}

// Only ever a page on the server this CLI pairs with: the URL comes back in
// the server's response, and a CLI that opens whatever it is told to is a
// redirect gadget.
export function openBrowser(url: string, baseUrl: string): boolean {
  try {
    if (new URL(url).origin !== new URL(baseUrl).origin) return false;
    const [cmd, args] = browserCommand(url);
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {}); // no opener installed: the printed URL stands
    child.unref();
    return true;
  } catch {
    return false;
  }
}
