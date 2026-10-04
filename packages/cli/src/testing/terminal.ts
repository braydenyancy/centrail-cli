// A stand-in for the process's stdio, for tests that drive the real prompts.
// The CLI asks a question only when stdin and stdout are both terminals, so
// `tty: true` swaps in a stdin marked as a TTY that yields the scripted lines
// and then ends, and marks stdout as one; `tty: false` is a hook's or a
// pipe's stdio — nothing marked, and a stdin that never ends, so a prompt
// that should not be there hangs the test instead of passing it. Everything
// the command prints is captured: prompts go through stdout.write, the rest
// through console.
import { PassThrough } from "node:stream";
import { vi } from "vitest";

export async function inTerminal<T>(
  opts: { tty: boolean; input?: string[] },
  fn: () => Promise<T>,
): Promise<{ result: T; output: string }> {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  if (opts.tty) {
    stdin.isTTY = true;
    for (const line of opts.input ?? []) stdin.write(`${line}\n`);
    stdin.end();
  }
  const stdinWas = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const ttyWas = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true, writable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: opts.tty, configurable: true, writable: true });
  const out: string[] = [];
  const capture = (...args: unknown[]) => void out.push(`${args.map(String).join(" ")}\n`);
  const spies = [
    vi.spyOn(console, "log").mockImplementation(capture),
    vi.spyOn(console, "warn").mockImplementation(capture),
    vi.spyOn(console, "error").mockImplementation(capture),
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }),
  ];
  try {
    const result = await fn();
    return { result, output: out.join("") };
  } finally {
    for (const s of spies) s.mockRestore();
    Object.defineProperty(process, "stdin", stdinWas);
    if (ttyWas) Object.defineProperty(process.stdout, "isTTY", ttyWas);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    stdin.destroy();
  }
}
