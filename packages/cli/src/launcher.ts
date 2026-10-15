import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR, replaceFile } from "./config.js";
import { detectChannel } from "./update.js";
import { CLI_VERSION } from "./version.js";

// The stable hook launcher (docs/integrations.md). Agent hook entries run
// `<config dir>/bin/centrail-hook` (`centrail-hook.cmd` on Windows) with
// fixed arguments, so the entry itself never changes across releases: Codex
// trusts a hook by the hash of its definition, and a pinned Node or bundle
// path breaks when a version manager prunes it or npx clears its cache.
// The launcher is the one file that knows where centrail lives, the way a
// version manager's shim does, and `centrail setup` rewrites it each run.
//
// It runs the first centrail that exists: the stable install that ran setup
// (a mise alias path or a global npm prefix), else `centrail` on PATH, else
// `npx -y centrail@<major>`. An npx cache path is never written into it.

export function launcherPath(dir: string = CONFIG_DIR, platform: NodeJS.Platform = process.platform): string {
  return join(dir, "bin", platform === "win32" ? "centrail-hook.cmd" : "centrail-hook");
}

export type LauncherTarget = {
  script: string | null; // a stable centrail entry point, or null for PATH/npx
  node: string | null; // the Node that ran setup, a last-resort candidate
  major: string; // npx fallback: the same major as the copy that wrote it
};

// mise's install dir is pinned through its `latest`/major alias when one
// resolves to this install; a global npm prefix is replaced in place by an
// update. The plugin cache (replaced by Claude Code), npx's cache (cleared
// at will) and unknown layouts (a checkout, Volta's image) are not stable.
export function stableScript(script: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const channel = detectChannel(script, env);
  if (channel !== "mise" && channel !== "npm-global") return null;
  const real = safeRealpath(script);
  if (real.replace(/\\/g, "/").includes("/_npx/")) return null;
  return stableInstallPath(real);
}

export function launcherTarget(
  script: string = process.argv[1] ?? "",
  node: string = process.execPath,
  previous: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): LauncherTarget {
  const stableNode = stableInstallPath(node);
  return {
    // A copy that is not stable (npx, a checkout) keeps the stable install
    // an earlier setup recorded, so running setup from npx never downgrades.
    script: stableScript(script, env) ?? previous,
    node: stableNode.replace(/\\/g, "/").includes("/_npx/") ? null : stableNode,
    major: CLI_VERSION.split(".")[0],
  };
}

// Node discovery shared with the Claude Code plugin's launcher
// (plugins/centrail/scripts/hook.sh holds this block verbatim; a test keeps
// them identical). Each candidate goes through the caller's `use`. Builtins
// only, so it runs under any PATH.
export const NODE_DISCOVERY_SH = `use "$(command -v node)"
cfg="\${CENTRAIL_CONFIG_DIR:-\${HOME:-}/.config/centrail}"
if [ -r "$cfg/node" ]; then
  read -r recorded < "$cfg/node"
  use "\${recorded:-}"
fi
for n in /opt/homebrew/bin/node /usr/local/bin/node \\
  "\${HOME:-}/.volta/bin/node" "\${HOME:-}/.local/share/mise/shims/node" "\${HOME:-}/.asdf/shims/node" \\
  "\${HOME:-}/.local/share/fnm/aliases/default/bin/node" "\${HOME:-}/Library/Application Support/fnm/aliases/default/bin/node"; do
  use "$n"
done
for n in "\${NVM_DIR:-\${HOME:-}/.nvm}"/versions/node/*/bin/node; do last="$n"; done
use "\${last:-}"
`;

const MISSING = "centrail: no centrail CLI or Node.js found for this hook; run `npx centrail setup` once in a terminal";

export function launcherScript(target: LauncherTarget, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? windowsLauncher(target) : posixLauncher(target);
}

function posixLauncher(t: LauncherTarget): string {
  return `#!/bin/sh
# centrail-hook: written by \`centrail setup\`, rewritten by each setup and
# upgrade; do not edit. Agent hooks run this fixed path, so their entries
# never change between releases. Finds a Node as the Claude Code plugin's
# hook.sh does, then runs the first centrail that exists: the install that
# ran setup, \`centrail\` on PATH, or npx. Arguments and stdin pass through.
script=${shQuote(t.script ?? "")}
pinned=${shQuote(t.node ?? "")}
node=
use() { [ -z "$node" ] && [ -n "$1" ] && [ -x "$1" ] && node="$1"; return 0; }
${NODE_DISCOVERY_SH}use "$pinned"
if [ -n "$node" ]; then
  PATH="\${node%/*}\${PATH:+:$PATH}"
  export PATH
  [ -n "$script" ] && [ -f "$script" ] && exec "$node" "$script" "$@"
fi
cli="$(command -v centrail)"
[ -n "$cli" ] && exec "$cli" "$@"
npx="$(command -v npx)"
[ -n "$npx" ] && exec "$npx" -y centrail@${t.major} "$@"
echo "${MISSING.replace(/`/g, "\\`")}" >&2
exit 1
`;
}

// cmd.exe: no parenthesised blocks, so %ERRORLEVEL% is read after the
// command it reports on. `call` returns from centrail.cmd/npx.cmd.
function windowsLauncher(t: LauncherTarget): string {
  const lines = [
    "@echo off",
    "rem centrail-hook.cmd: written by `centrail setup`, rewritten by each setup and upgrade; do not edit.",
    "rem Runs the install that ran setup, else centrail on PATH, else npx. Arguments and stdin pass through.",
    "setlocal",
    `set "script=${cmdValue(t.script ?? "")}"`,
    `set "pinned=${cmdValue(t.node ?? "")}"`,
    'set "node="',
    'for %%I in (node.exe) do set "node=%%~$PATH:I"',
    'set "cfg=%CENTRAIL_CONFIG_DIR%"',
    'if not defined cfg set "cfg=%USERPROFILE%\\.config\\centrail"',
    'if not defined node if exist "%cfg%\\node" set /p node=<"%cfg%\\node"',
    'if defined node if not exist "%node%" set "node="',
    'if not defined node if exist "%pinned%" set "node=%pinned%"',
    'if not defined node if exist "%ProgramFiles%\\nodejs\\node.exe" set "node=%ProgramFiles%\\nodejs\\node.exe"',
    'if not defined node if exist "%LOCALAPPDATA%\\Volta\\bin\\node.exe" set "node=%LOCALAPPDATA%\\Volta\\bin\\node.exe"',
    'if defined node for %%D in ("%node%") do set "PATH=%%~dpD;%PATH%"',
    'if defined node if exist "%script%" goto run_script',
    'set "cli="',
    'for %%I in (centrail.cmd) do set "cli=%%~$PATH:I"',
    "if defined cli goto run_cli",
    'set "npx="',
    'for %%I in (npx.cmd) do set "npx=%%~$PATH:I"',
    "if defined npx goto run_npx",
    `>&2 echo ${MISSING.replace(/`/g, "")}`,
    "exit /b 1",
    ":run_script",
    '"%node%" "%script%" %*',
    "exit /b %ERRORLEVEL%",
    ":run_cli",
    'call "%cli%" %*',
    "exit /b %ERRORLEVEL%",
    ":run_npx",
    `call "%npx%" -y centrail@${t.major} %*`,
    "exit /b %ERRORLEVEL%",
  ];
  return `${lines.join("\r\n")}\r\n`;
}

// The stable install a launcher on disk points at, so a later setup from a
// non-stable copy keeps it, and doctor can tell whether it still exists.
export function launcherScriptPath(content: string): string | null {
  return launcherValue(content, "script");
}

export function launcherValue(content: string, name: "script" | "pinned"): string | null {
  const posix = new RegExp(`^${name}='((?:[^']|'\\\\'')*)'$`, "m").exec(content);
  if (posix) return posix[1].replace(/'\\''/g, "'") || null;
  const win = new RegExp(`^set "${name}=([^"\\r\\n]*)"\\r?$`, "m").exec(content);
  return win ? win[1] || null : null;
}

export async function readLauncher(path: string = launcherPath()): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

// Atomic (temp file + rename) and executable. Returns whether it changed.
export async function writeLauncher(content: string, path: string = launcherPath()): Promise<boolean> {
  if ((await readLauncher(path)) === content && (await isExecutable(path))) return false;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content, { mode: 0o755 });
  await chmod(tmp, 0o755); // the umask may have narrowed it
  await replaceFile(tmp, path);
  return true;
}

export async function removeLauncher(path: string = launcherPath()): Promise<boolean> {
  if ((await readLauncher(path)) === null) return false;
  await rm(path, { force: true });
  return true;
}

export async function isExecutable(path: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile() && (platform === "win32" || (s.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

// mise installs each tool version under `…/installs/<tool>/<version>/` and keeps
// alias links beside it (`latest`, the major). A path pinned to the version dir
// breaks when that version is upgraded and pruned; pinned through an alias it
// follows the upgrade. An alias is used only when it resolves to this very
// install, so installing never switches versions. `latest` survives a major
// bump; the major alias is the fallback when a newer major is installed beside
// it. Without a matching alias (asdf, nvm, a plain install) the path is kept;
// the launcher then falls back to PATH or npx if it disappears.
export function stableInstallPath(p: string): string {
  const m = /^(.*[\\/]installs[\\/][^\\/]+[\\/])([^\\/]+)([\\/].*)$/.exec(p);
  if (!m) return p;
  const [, base, version, rest] = m;
  const target = safeRealpath(p);
  for (const alias of ["latest", version.split(".")[0]]) {
    if (alias === version) return p;
    const candidate = `${base}${alias}${rest}`;
    if (safeRealpath(candidate) === target && candidate !== target) return candidate;
  }
  return p;
}

export function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function shQuote(s: string): string {
  if (/[\n\r]/.test(s)) throw new Error("Cannot write a launcher with a newline in a path.");
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function cmdValue(s: string): string {
  if (/[\n\r"%]/.test(s)) throw new Error("Cannot write a Windows launcher with quotes, percent signs or newlines in a path.");
  return s;
}
