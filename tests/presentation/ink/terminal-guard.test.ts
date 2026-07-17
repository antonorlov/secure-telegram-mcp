/**
 * Terminal guard — the abort+restore invariant. With an injected fake `TerminalIo`
 * (no real TTY/signals) we pin:
 *   - enter alt-screen + hide cursor before the body; leave + show after,
 *   - restore even when the body throws,
 *   - a SIGINT handler restores ONCE (idempotent), de-registers, and exits 130,
 *   - non-TTY runs skip the alt-screen entirely (nothing to restore).
 */
import { describe, it, expect } from 'vitest';
import {
  AltScreenTerminalGuard,
  type GuardSignal,
  type TerminalIo,
} from '../../../src/presentation/cli/ink/terminal-guard.js';

interface Harness {
  readonly io: TerminalIo;
  readonly writes: string[];
  readonly handlers: Map<GuardSignal, Set<() => void>>;
  readonly exits: number[];
  fire(signal: GuardSignal): void;
}

const makeHarness = (isTty: boolean): Harness => {
  const writes: string[] = [];
  const handlers = new Map<GuardSignal, Set<() => void>>();
  const exits: number[] = [];
  const io: TerminalIo = {
    write: (sequence) => {
      writes.push(sequence);
    },
    isTty,
    on: (signal, handler) => {
      const set = handlers.get(signal);
      if (set) set.add(handler);
      else handlers.set(signal, new Set([handler]));
    },
    off: (signal, handler) => {
      handlers.get(signal)?.delete(handler);
    },
    exit: (code) => {
      exits.push(code);
    },
  };
  return {
    io,
    writes,
    handlers,
    exits,
    fire: (signal): void => {
      for (const handler of handlers.get(signal) ?? []) handler();
    },
  };
};

const joined = (h: Harness): string => h.writes.join('');
const allHandlersGone = (h: Harness): boolean =>
  [...h.handlers.values()].every((set) => set.size === 0);

describe('AltScreenTerminalGuard', () => {
  it('brackets the body with enter/restore and removes handlers', async () => {
    const h = makeHarness(true);
    const guard = new AltScreenTerminalGuard(h.io);
    const result = await guard.run(() => {
      // Inside the body the alt-screen is entered + cursor hidden.
      expect(joined(h)).toContain('1049h');
      expect(joined(h)).toContain('25l');
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(joined(h)).toContain('1049l'); // left alt-screen
    expect(joined(h)).toContain('25h'); // cursor restored
    expect(allHandlersGone(h)).toBe(true);
  });

  it('restores the terminal even when the body throws', async () => {
    const h = makeHarness(true);
    const guard = new AltScreenTerminalGuard(h.io);
    await expect(
      guard.run(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(joined(h)).toContain('1049l');
    expect(allHandlersGone(h)).toBe(true);
  });

  it('a SIGINT handler restores once, de-registers, and exits 130', async () => {
    const h = makeHarness(true);
    const guard = new AltScreenTerminalGuard(h.io);
    await guard.run(() => {
      expect(h.handlers.get('SIGINT')?.size).toBe(1);
      h.fire('SIGINT');
      return Promise.resolve();
    });
    expect(h.exits).toContain(130);
    // restore is idempotent: exactly one alt-screen leave despite handler + finally.
    expect(joined(h).match(/1049l/g) ?? []).toHaveLength(1);
  });

  it('interrupt() gives raw Ctrl-C the same restore-and-exit path', async () => {
    const h = makeHarness(true);
    const guard = new AltScreenTerminalGuard(h.io);
    await guard.run(() => {
      guard.interrupt();
      return Promise.resolve();
    });
    expect(h.exits).toEqual([130]);
    expect(joined(h).match(/1049l/g) ?? []).toHaveLength(1);
    expect(allHandlersGone(h)).toBe(true);
  });

  it('non-TTY runs skip the alt-screen entirely', async () => {
    const h = makeHarness(false);
    const guard = new AltScreenTerminalGuard(h.io);
    const result = await guard.run(() => Promise.resolve(42));
    expect(result).toBe(42);
    expect(h.writes).toHaveLength(0);
    expect(h.handlers.size).toBe(0);
  });
});
