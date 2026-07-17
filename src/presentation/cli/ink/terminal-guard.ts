/**
 * Terminal guard — owns the alternate screen for the wizard and guarantees the terminal is
 * restored: on normal return, on a thrown error, and on Ctrl-C / SIGTERM. Without this, a
 * crash mid-render would leave the user in the alt-screen with a hidden cursor.
 *
 * It enters the alt-screen + hides the cursor before the body, and on the way out shows the
 * cursor + leaves the alt-screen — idempotently, so the `finally` path and a signal handler
 * can both fire without double-emitting. The signal handler restores, de-registers itself,
 * and exits `128 + signo`.
 *
 * The side-effects are injected through a tiny `TerminalIo` port so the guarantees are
 * unit-tested with a fake — no real TTY or process signals needed. Non-TTY runs (CI / piped)
 * skip the alt-screen entirely.
 */

// xterm control sequences (DEC private modes).
const ALT_ENTER = '[?1049h';
const ALT_LEAVE = '[?1049l';
const CURSOR_HIDE = '[?25l';
const CURSOR_SHOW = '[?25h';

export type GuardSignal = 'SIGINT' | 'SIGTERM';

/** Signals the guard restores on, with their conventional exit codes (128+signo). */
const SIGNAL_EXIT_CODES: readonly (readonly [GuardSignal, number])[] = Object.freeze([
  ['SIGINT', 130],
  ['SIGTERM', 143],
]);

/** The injectable terminal side-effects (a fake backs the tests). */
export interface TerminalIo {
  write(sequence: string): void;
  readonly isTty: boolean;
  on(signal: GuardSignal, handler: () => void): void;
  off(signal: GuardSignal, handler: () => void): void;
  exit(code: number): void;
}

/**
 * The real adapter over `process`, targeting one write stream (default STDOUT, where the Ink
 * picker renders). The arrow-nav menu renders to STDERR — reserving STDOUT for the copy-paste
 * config block — so it passes `process.stderr` here, reusing the same alt-screen/restore
 * machinery rather than a second io.
 */
export const createProcessTerminalIo = (
  stream: NodeJS.WriteStream = process.stdout,
): TerminalIo => ({
  write: (sequence: string): void => {
    stream.write(sequence);
  },
  isTty: stream.isTTY,
  on: (signal: GuardSignal, handler: () => void): void => {
    process.on(signal, handler);
  },
  off: (signal: GuardSignal, handler: () => void): void => {
    process.off(signal, handler);
  },
  exit: (code: number): void => {
    process.exit(code);
  },
});

/**
 * The alt-screen terminal guard. Construct once per wizard run; `run` brackets the
 * Ink runtime with enter/restore and the signal safety net.
 */
export class AltScreenTerminalGuard {
  private readonly io: TerminalIo;
  private activeInterrupt: (() => void) | undefined;

  public constructor(io: TerminalIo = createProcessTerminalIo()) {
    this.io = io;
  }

  public interrupt(): void {
    if (this.activeInterrupt !== undefined) {
      this.activeInterrupt();
      return;
    }
    this.io.exit(130);
  }

  public async run<T>(body: () => Promise<T>): Promise<T> {
    // Non-interactive: nothing to enter, nothing to restore.
    if (!this.io.isTty) {
      return body();
    }

    let restored = false;
    const restore = (): void => {
      if (restored) return;
      restored = true;
      this.io.write(`${CURSOR_SHOW}${ALT_LEAVE}`);
    };

    const registered: { readonly signal: GuardSignal; readonly handler: () => void }[] = [];
    const cleanup = (): void => {
      for (const r of registered) this.io.off(r.signal, r.handler);
      registered.length = 0;
    };
    const interrupt = (): void => {
      restore();
      cleanup();
      this.io.exit(130);
    };
    this.activeInterrupt = interrupt;

    for (const [signal, code] of SIGNAL_EXIT_CODES) {
      const handler = (): void => {
        restore();
        cleanup();
        this.io.exit(code);
      };
      registered.push({ signal, handler });
      this.io.on(signal, handler);
    }

    this.io.write(`${ALT_ENTER}${CURSOR_HIDE}`);
    try {
      return await body();
    } finally {
      if (this.activeInterrupt === interrupt) {
        this.activeInterrupt = undefined;
      }
      cleanup();
      restore();
    }
  }
}
