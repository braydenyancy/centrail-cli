import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { progress, progressDone, progressEnabled, progressStatus, setProgressMode } from "./progress.js";

afterEach(() => setProgressMode("auto"));

describe("progressEnabled", () => {
  it("shows progress only to a person at a terminal by default", () => {
    expect(progressEnabled({}, true)).toBe(true);
    expect(progressEnabled({}, false)).toBe(false); // the hook's detached sync, an agent's pipe
    expect(progressEnabled({ CI: "true" }, true)).toBe(false);
  });

  it("--verbose forces it on and --quiet off", () => {
    setProgressMode("verbose");
    expect(progressEnabled({ CI: "true" }, false)).toBe(true);
    setProgressMode("quiet");
    expect(progressEnabled({}, true)).toBe(false);
  });
});

// The writes themselves: stderr stubbed as a terminal (or not), the clock
// faked, so a 21-second scan behind one line takes no time at all.
describe("the status line", () => {
  let writes: string[];
  const ttyWas = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  const stderrIsTTY = (value: boolean) =>
    Object.defineProperty(process.stderr, "isTTY", { value, configurable: true, writable: true });
  const last = () => writes[writes.length - 1];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("CI", "");
    writes = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    progressDone();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    if (ttyWas) Object.defineProperty(process.stderr, "isTTY", ttyWas);
    else delete (process.stderr as { isTTY?: boolean }).isTTY;
  });

  it("on a terminal, a status that says nothing new is redrawn every second with its age, until done clears it", () => {
    stderrIsTTY(true);
    progressStatus("claude-code: reading logs (full history)…");
    expect(writes).toEqual(["\r\x1b[K  claude-code: reading logs (full history)…"]);
    vi.advanceTimersByTime(1000);
    expect(last()).toBe("\r\x1b[K  claude-code: reading logs (full history)… · 1s");
    vi.advanceTimersByTime(13_000);
    expect(last()).toBe("\r\x1b[K  claude-code: reading logs (full history)… · 14s");
    expect(writes.every((w) => !w.includes("\n"))).toBe(true); // one line, rewritten in place
    vi.advanceTimersByTime(60_000);
    expect(last()).toBe("\r\x1b[K  claude-code: reading logs (full history)… · 1m 14s");

    progressDone();
    expect(last()).toBe("\r\x1b[K");
    const n = writes.length;
    vi.advanceTimersByTime(5000);
    expect(writes).toHaveLength(n); // the heartbeat stopped with it
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a counter keeps its phase's clock and redraws at most every 100 ms; new words start a new clock", () => {
    stderrIsTTY(true);
    progressStatus("claude-code: reading logs — 1/5,678 files");
    vi.advanceTimersByTime(2500);
    progressStatus("claude-code: reading logs — 2,000/5,678 files");
    expect(last()).toBe("\r\x1b[K  claude-code: reading logs — 2,000/5,678 files · 2s");
    vi.advanceTimersByTime(50);
    progressStatus("claude-code: reading logs — 2,001/5,678 files"); // too soon: kept, not drawn
    expect(last()).toContain("2,000/5,678");
    vi.advanceTimersByTime(450); // the heartbeat draws the latest
    expect(last()).toBe("\r\x1b[K  claude-code: reading logs — 2,001/5,678 files · 3s");

    progressStatus("claude-code: finding the repo of 115,000 events…");
    expect(last()).toBe("\r\x1b[K  claude-code: finding the repo of 115,000 events…");
    progress("claude-code: 3 new, 0 already synced"); // a line that stays ends the status
    expect(last()).toBe("  claude-code: 3 new, 0 already synced\n");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("without a terminal, or in CI, or with --quiet: nothing at all, and nothing ticking", () => {
    const silent = (setup: () => void) => {
      setup();
      progressStatus("claude-code: reading logs (full history)…");
      progressStatus("claude-code: reading logs — 1/2 files");
      vi.advanceTimersByTime(10_000);
      progress("claude-code: 3 new, 0 already synced");
      progressDone();
      expect(writes).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      setProgressMode("auto");
      vi.unstubAllEnvs();
    };
    silent(() => stderrIsTTY(false)); // the hook's detached sync, an agent's pipe
    silent(() => {
      stderrIsTTY(true);
      vi.stubEnv("CI", "true");
    });
    silent(() => {
      stderrIsTTY(true);
      setProgressMode("quiet");
    });
  });

  it("--verbose into a file: a line per phase, a counter at most once a second, no heartbeat", () => {
    stderrIsTTY(false);
    setProgressMode("verbose");
    progressStatus("claude-code: reading logs (full history)…");
    for (let i = 1; i <= 5; i++) {
      vi.advanceTimersByTime(300);
      progressStatus(`claude-code: reading logs — ${i}/5 files`);
    }
    vi.advanceTimersByTime(10_000);
    progressStatus("claude-code: sending 250 of 300 events");
    expect(writes).toEqual([
      "  claude-code: reading logs (full history)…\n",
      "  claude-code: reading logs — 1/5 files\n",
      "  claude-code: reading logs — 5/5 files\n",
      "  claude-code: sending 250 of 300 events\n",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
