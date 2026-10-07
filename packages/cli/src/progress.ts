// Progress for a person watching a terminal, on stderr. A sync the Stop hook
// starts runs detached with stdio ignored, and an agent that runs `sync`
// reads piped stdout: both see exactly what they saw before, the summary
// lines, and no progress at all. `--verbose` forces it on (a log file, a
// pipe you are watching); `--quiet` forces it off.
export type ProgressMode = "auto" | "verbose" | "quiet";

let mode: ProgressMode = "auto";
let inline = false; // the last write was a rewritable status line

// The status line on screen. Its phase is its text with the numbers blanked:
// a counter ticking ("12/340 files", "13/340 files") stays one phase and
// keeps that phase's clock; new words start a new one.
type Status = { message: string; phase: string; since: number; drawnAt: number };
let status: Status | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;

// A phase that has said nothing new for this long shows its age, so a
// minute of reading a 4 GB history never looks like a hang.
const HEARTBEAT_MS = 1000;
// A counter ticks once per file. A terminal redraws it at most this often
// (the heartbeat draws the latest); a log gets at most a line a second.
const REDRAW_MS = 100;

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
  stopStatus();
  process.stderr.write(`  ${message}\n`);
}

// One line the next write replaces (a batch counter), redrawn every second
// with how long its phase has run: `reading logs — 12/340 files · 14s`.
// Without a terminal to rewrite it in (`--verbose` into a file), each phase
// is its own line, a counter at most once a second, and nothing ticks.
export function progressStatus(message: string): void {
  if (!progressEnabled()) return;
  const now = Date.now();
  const tty = process.stderr.isTTY === true;
  const phase = message.replace(/\d[\d,]*/g, "#");
  if (status?.phase === phase) {
    status.message = message;
    if (now - status.drawnAt < (tty ? REDRAW_MS : HEARTBEAT_MS)) return;
  } else {
    status = { message, phase, since: now, drawnAt: 0 };
  }
  status.drawnAt = now;
  if (!tty) {
    process.stderr.write(`  ${message}\n`);
    return;
  }
  drawStatus(now);
  if (!heartbeat) {
    heartbeat = setInterval(() => drawStatus(Date.now()), HEARTBEAT_MS);
    heartbeat.unref(); // never what keeps the process alive
  }
}

// Clear a pending status line before the summary prints on stdout, or an
// error on stderr.
export function progressDone(): void {
  if (inline && progressEnabled()) process.stderr.write("\r\x1b[K");
  inline = false;
  stopStatus();
}

function drawStatus(now: number): void {
  if (!status) return;
  const secs = Math.floor((now - status.since) / 1000);
  const age = secs < 1 ? "" : secs < 60 ? ` · ${secs}s` : ` · ${Math.floor(secs / 60)}m ${secs % 60}s`;
  process.stderr.write(`\r\x1b[K  ${status.message}${age}`);
  inline = true;
}

function stopStatus(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  status = null;
}
