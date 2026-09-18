/**
 * The one way a suite starts an in-process daemon. A daemon that outlives its case keeps two
 * listening sockets and a one-shot signal handler alive, so start and stop are a pair here:
 * shutdown invokes only the handlers THIS daemon installed — emitting the signal on `process`
 * would tear down every other live daemon — and it fails loudly rather than assuming an exit
 * that never arrived.
 */
import { connect as netConnect } from 'node:net';

import { daemon, type DaemonOptions } from '../../src/presentation/mcp/daemon.js';
import { daemonAddress, operatorAddress } from '../../src/infrastructure/index.js';

// The harness owns logging, exit reporting and shutdown; everything else is the suite's.
export type HarnessOptions = Omit<DaemonOptions, 'logger' | 'exit'>;

/**
 * The daemon entrypoint, injectable so the fixture's own suite can drive the shutdown paths
 * — a failed exit, a socket left listening — against a double it fully owns. A real daemon
 * whose teardown throws leaves its tool socket to `process.exit`, which an in-process test
 * cannot close, so exercising that here would leak a listening server into the worker.
 */
export type DaemonEntrypoint = (options: DaemonOptions) => Promise<void>;

// A daemon that will not exit is a defect, not a slow machine: this bound is generous.
const SHUTDOWN_DEADLINE_MS = 10_000;

/**
 * Startup is serialized process-wide. The only handle a daemon offers on its shutdown is the
 * signal listener it installs, which this harness identifies by diffing the process listeners
 * around `daemon()`. Two overlapping starts would each claim the other's listener, and stopping
 * one would then shut both down.
 */
let startGate: Promise<void> = Promise.resolve();

const isListening = (address: string): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const probe = netConnect(address);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => {
      resolve(false);
    });
  });

const waitForSocket = async (address: string): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (await isListening(address)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`daemon socket never came up at ${address}`);
};

export class DaemonHarness {
  private readonly signalListeners: {
    readonly signal: 'SIGINT' | 'SIGTERM';
    readonly listener: NodeJS.SignalsListener;
  }[] = [];
  private readonly exits: number[] = [];
  private readonly log: string[] = [];
  // One shutdown, shared by every caller: a second `stop()` must await the SAME completion,
  // not return while the first is still draining.
  private stopping: Promise<void> | undefined;

  private constructor(public readonly sessionDir: string) {}

  // Resolves once both planes are listening: the tool socket and the operator socket.
  public static async start(
    options: HarnessOptions,
    run: DaemonEntrypoint = daemon,
  ): Promise<DaemonHarness> {
    const harness = new DaemonHarness(options.sessionDir);
    const previous = startGate;
    let release = (): void => undefined;
    startGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const before = {
        SIGINT: new Set(process.listeners('SIGINT')),
        SIGTERM: new Set(process.listeners('SIGTERM')),
      };
      await run({
        ...options,
        logger: (message: string) => {
          harness.log.push(message);
        },
        exit: (code: number) => {
          harness.exits.push(code);
        },
      });
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        for (const listener of process.listeners(signal)) {
          if (!before[signal].has(listener)) {
            harness.signalListeners.push({ signal, listener });
          }
        }
      }
    } finally {
      release();
    }
    if (run === daemon) {
      await waitForSocket(daemonAddress(options.sessionDir));
      await waitForSocket(operatorAddress(options.sessionDir));
    }
    return harness;
  }

  public address(): string {
    return daemonAddress(this.sessionDir);
  }

  public logLines(): readonly string[] {
    return this.log;
  }

  public exitCodes(): readonly number[] {
    return this.exits;
  }

  // How many signal handlers this harness claims as its own — two, or it captured a neighbour's.
  public ownedHandlerCount(): number {
    return this.signalListeners.length;
  }

  // The exit code the daemon reported within the window, or -1 when it kept running.
  public async waitForExit(timeoutMs: number): Promise<number> {
    const deadlineMs = Date.now() + timeoutMs;
    while (Date.now() < deadlineMs) {
      const code = this.exits[0];
      if (code !== undefined) return code;
      await new Promise((r) => setTimeout(r, 10));
    }
    return -1;
  }

  /**
   * Safe to call twice and from two places at once: every caller awaits the one shutdown and
   * sees the same outcome. A nonzero exit is a FAILED shutdown — the in-process daemon's
   * sockets outlive it, because the harness replaced `process.exit` with a recorder — so it is
   * raised, not swallowed.
   */
  public stop(): Promise<void> {
    this.stopping ??= this.runStop();
    return this.stopping;
  }

  private async runStop(): Promise<void> {
    const owned = [...this.signalListeners];
    // Detached first, so the daemon's own `once` registration cannot also fire later.
    for (const { signal, listener } of owned) process.off(signal, listener);
    this.signalListeners.length = 0;
    await this.shutDown(owned);
  }

  private async shutDown(
    owned: readonly {
      readonly signal: 'SIGINT' | 'SIGTERM';
      readonly listener: NodeJS.SignalsListener;
    }[],
  ): Promise<void> {
    // Read through a call: the exit lands in an async callback the compiler cannot see.
    const reported = (): number | undefined => this.exits[0];
    if (reported() === undefined) {
      const term = owned.filter((entry) => entry.signal === 'SIGTERM');
      if (term.length === 0) {
        throw new Error('the daemon installed no SIGTERM handler to shut it down');
      }
      for (const { listener } of term) listener('SIGTERM');
      const deadlineMs = Date.now() + SHUTDOWN_DEADLINE_MS;
      while (reported() === undefined) {
        if (Date.now() > deadlineMs) {
          throw new Error(
            `the daemon did not exit within ${String(SHUTDOWN_DEADLINE_MS)}ms`,
          );
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    const code = reported();
    if (code !== 0) {
      throw new Error(
        `the daemon exited with ${String(code)}: shutdown failed and its sockets may still be listening`,
      );
    }
    // The exit code is the daemon's own account of the shutdown; this is the independent one.
    for (const address of [
      daemonAddress(this.sessionDir),
      operatorAddress(this.sessionDir),
    ]) {
      if (await isListening(address)) {
        throw new Error(`the daemon exited but ${address} is still listening`);
      }
    }
  }
}
