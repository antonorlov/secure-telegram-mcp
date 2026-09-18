// A PTY driver for CLI suites: waits on output, types, and can assert that something never
// appeared — the shape a secret check needs.
import { spawn, type IPty } from 'node-pty';

const CSI = new RegExp(`\u001b\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const OSC = new RegExp(`\u001b\\][^\\u0007]*(?:\\u0007|\u001b\\\\)`, 'g');

// Strips CSI/OSC so assertions match what an operator reads, not the escape soup.
const strip = (raw: string): string => raw.replace(OSC, '').replace(CSI, '');

export interface WaitOptions {
  readonly timeoutMs?: number;
  // Start searching here, so a repeated prompt must appear AGAIN rather than matching the
  // one already on screen. Pass the previous wait's return value.
  readonly from?: number;
}

export interface PtySession {
  readonly term: IPty;
  snapshot(): string;
  type(data: string): void;
  // Resolves with the offset just past the match, ready to be the next wait's `from`.
  waitFor(pattern: RegExp, options?: WaitOptions): Promise<number>;
  waitForExit(timeoutMs?: number): Promise<number>;
  containsSecret(secret: string): boolean;
  kill(): void;
}

export const spawnPty = (input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly cols?: number;
  readonly rows?: number;
}): PtySession => {
  const term = spawn(input.command, [...input.args], {
    name: 'xterm-256color',
    cols: input.cols ?? 80,
    rows: input.rows ?? 30,
    cwd: input.cwd,
    env: input.env,
  });
  let buffer = '';
  let exitCode: number | undefined;
  term.onData((chunk) => {
    buffer += chunk;
  });
  term.onExit((event) => {
    exitCode = event.exitCode;
  });

  const snapshot = (): string => strip(buffer);
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  return {
    term,
    snapshot,
    type: (data: string): void => {
      term.write(data);
    },
    waitFor: async (pattern: RegExp, options: WaitOptions = {}): Promise<number> => {
      const { timeoutMs = 10_000, from = 0 } = options;
      // Rebuilt without /g: a sticky lastIndex would silently skip matches between polls.
      const probe = new RegExp(pattern.source, pattern.flags.replace('g', ''));
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = probe.exec(snapshot().slice(from));
        if (match !== null) return from + match.index + match[0].length;
        await sleep(25);
      }
      throw new Error(
        `timed out waiting for ${pattern.source} after offset ${String(from)}; saw: ${snapshot().slice(-400)}`,
      );
    },
    waitForExit: async (timeoutMs = 10_000): Promise<number> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (exitCode !== undefined) return exitCode;
        await sleep(25);
      }
      throw new Error(`process did not exit; saw: ${snapshot().slice(-400)}`);
    },
    containsSecret: (secret: string): boolean => snapshot().includes(secret),
    kill: (): void => {
      try {
        term.kill();
      } catch {
        // already gone
      }
    },
  };
};
