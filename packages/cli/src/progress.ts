// Progress for a person watching a terminal, on stderr. A sync the Stop hook
// starts runs detached with stdio ignored, and an agent that runs `sync`
// reads piped stdout: both see exactly what they saw before, the summary
// lines, and no progress at all. `--verbose` forces it on (a log file, a
// pipe you are watching); `--quiet` forces it off.
export type ProgressMode = "auto" | "verbose" | "quiet";

let mode: ProgressMode = "auto";
let inline = false; // the last write was a rewritable status line

export function setProgressMode(next: ProgressMode): void {
  mode = next;
}

export function progressEnabled(
  env: Record<string, string | undefined> = process.env,
  isTTY = process.stderr.isTTY === true,
): boolean {
  if (mode === "quiet") return false;
  if (mode === "verbose") return true;
  return isTTY && !env.CI;
}

// One line that stays.
export function progress(message: string): void {
  if (!progressEnabled()) return;
  if (inline) process.stderr.write("\r\x1b[K");
  inline = false;
  process.stderr.write(`  ${message}\n`);
}

// One line the next write replaces (a batch counter). Without a terminal to
// rewrite it in (`--verbose` into a file), each is its own line.
export function progressStatus(message: string): void {
  if (!progressEnabled()) return;
  if (process.stderr.isTTY !== true) {
    process.stderr.write(`  ${message}\n`);
    return;
  }
  process.stderr.write(`\r\x1b[K  ${message}`);
  inline = true;
}

// Clear a pending status line before the summary prints on stdout.
export function progressDone(): void {
  if (inline && progressEnabled()) process.stderr.write("\r\x1b[K");
  inline = false;
}
