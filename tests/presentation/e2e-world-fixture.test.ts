/**
 * The shared socket-level fixture is itself load-bearing: if teardown shut down daemons it does
 * not own, or reported a shutdown it never observed, every suite built on it would be reporting
 * someone else's state. Two live worlds are the only way to prove ownership.
 */
import { describe, it, expect } from 'vitest';
import { connect as netConnect, createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TelegramClient } from 'telegram';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { daemonAddress } from '../../src/infrastructure/index.js';
import {
  hashEndpointToken,
  mintEndpointToken,
} from '../../src/infrastructure/endpoint-token.js';
import { FakeTelegramClient } from '../_support/fake-telegram-client.js';
import { SocketClientTransport } from '../_support/socket-mcp-client.js';
import {
  DaemonHarness,
  type DaemonEntrypoint,
  type HarnessOptions,
} from '../_support/daemon-harness.js';
import { E2EWorld } from '../_support/e2e-world.js';
import { guardProcessResources } from '../_support/resource-guards.js';

const PIN = 'correct-horse-battery';
const EMPTY_CONFIG = { version: 1, endpoints: [] };
const SCOPED_ID = 100;

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

describe.skipIf(process.platform === 'win32')('E2EWorld teardown ownership', () => {
  guardProcessResources();

  it('disposing one world leaves another running, then shuts its own down', async () => {
    const first = await E2EWorld.create('tmcp-world-a-');
    const second = await E2EWorld.create('tmcp-world-b-');
    try {
      for (const world of [first, second]) {
        await world.seal({ config: EMPTY_CONFIG, sessionRefs: ['acct'], pin: PIN });
        await world.startDaemon();
      }
      const secondAddress = second.address();

      await first.dispose();

      expect(first.exitCodes()).toEqual([0]);
      // The bystander must still be serving: teardown is per fixture, not per process.
      expect(second.exitCodes()).toEqual([]);
      expect(await isListening(secondAddress)).toBe(true);

      await second.dispose();

      expect(second.exitCodes()).toEqual([0]);
      expect(await isListening(secondAddress)).toBe(false);
    } finally {
      await first.dispose().catch(() => undefined);
      await second.dispose().catch(() => undefined);
    }
  }, 30_000);

  /**
   * The harness identifies a daemon's shutdown by diffing the process signal listeners around
   * its start. Overlapping starts make those intervals overlap, so without serialization one
   * harness claims both daemons' handlers and stopping it takes the bystander down too.
   */
  it('keeps ownership straight when two worlds start concurrently', async () => {
    const first = await E2EWorld.create('tmcp-world-d-');
    const second = await E2EWorld.create('tmcp-world-e-');
    try {
      await Promise.all(
        [first, second].map((world) =>
          world.seal({ config: EMPTY_CONFIG, sessionRefs: ['acct'], pin: PIN }),
        ),
      );
      await Promise.all([first.startDaemon(), second.startDaemon()]);
      const firstAddress = first.address();

      // One SIGINT and one SIGTERM handler each: the later starter is the one that would
      // otherwise sweep up the earlier daemon's handlers as well.
      expect(first.ownedHandlerCount()).toBe(2);
      expect(second.ownedHandlerCount()).toBe(2);

      await second.dispose();

      expect(first.exitCodes()).toEqual([]);
      expect(await isListening(firstAddress)).toBe(true);

      await first.dispose();
      expect(first.exitCodes()).toEqual([0]);
    } finally {
      await first.dispose().catch(() => undefined);
      await second.dispose().catch(() => undefined);
    }
  }, 30_000);

  /**
   * A real daemon whose teardown throws leaves its tool socket for `process.exit` to close, so
   * an in-process case cannot clean up after it. These drive the same shutdown paths through a
   * double whose every resource belongs to this suite.
   */
  describe('shutdown outcomes', () => {
    const options = {
      sessionDir: '/nonexistent/harness-double',
      sessionKey: { kind: 'machine' },
      auditLogPath: '/nonexistent/audit.log',
      mediaRootDir: '/nonexistent/media',
      makeConfigRepository: () => {
        throw new Error('the double never builds a repository');
      },
      plainConfigRepository: {},
      configParser: {},
    } as unknown as HarnessOptions;

    // A daemon that installs the one handle the harness owns it by, then exits as told.
    const doubleExiting = (code: number): DaemonEntrypoint => (given): Promise<void> => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
          given.exit?.(code);
        });
      }
      return Promise.resolve();
    };

    it('rejects a nonzero exit, and rejects it again for every later caller', async () => {
      const harness = await DaemonHarness.start(options, doubleExiting(1));

      await expect(harness.stop()).rejects.toThrow(/exited with 1/);
      await expect(harness.stop()).rejects.toThrow(/exited with 1/);
    }, 20_000);

    it('gives every overlapping caller the one shutdown, not an early return', async () => {
      let exited = 0;
      const slow: DaemonEntrypoint = (given): Promise<void> => {
        for (const signal of ['SIGINT', 'SIGTERM'] as const) {
          process.once(signal, () => {
            setTimeout(() => {
              exited += 1;
              given.exit?.(0);
            }, 150);
          });
        }
        return Promise.resolve();
      };
      const harness = await DaemonHarness.start(options, slow);

      const [first, second] = [harness.stop(), harness.stop()];
      await second;
      // The second caller returned only once the exit had actually been reported.
      expect(exited).toBe(1);
      expect(harness.exitCodes()).toEqual([0]);
      await first;
    }, 20_000);

    it('rejects a clean exit that left a socket listening', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tmcp-harness-'));
      const lingering = createServer();
      try {
        await new Promise<void>((resolve) => {
          lingering.listen(daemonAddress(dir), () => {
            resolve();
          });
        });
        const harness = await DaemonHarness.start(
          { ...options, sessionDir: dir },
          doubleExiting(0),
        );

        await expect(harness.stop()).rejects.toThrow(/still listening/);
      } finally {
        // The suite opened this server, so the suite closes it: nothing outlives the case.
        await new Promise<void>((resolve) => {
          lingering.close(() => {
            resolve();
          });
        });
        await rm(dir, { recursive: true, force: true });
      }
    }, 20_000);
  });

  /**
   * Teardown callers overlap in practice — an `afterEach` and a `finally`, or a cleanup racing
   * a timed-out case. The second one must join the shutdown in flight; returning early would
   * delete the state directory while Telegram teardown and the listener are still live.
   */
  it('makes a second teardown caller wait for the shutdown, not walk past it', async () => {
    let destroyed = false;
    const token = mintEndpointToken();
    const world = await E2EWorld.create('tmcp-world-g-');
    const mcp = new Client({ name: 'fixture-test', version: '0.0.0' });
    try {
      await world.seal({
        config: {
          version: 1,
          endpoints: [
            {
              name: 'worker',
              session: 'acct',
              scope: { chats: [String(SCOPED_ID)], folders: [] },
              verbs: ['read'],
              tokenHash: hashEndpointToken(token),
            },
          ],
        },
        sessionRefs: ['acct'],
        pin: PIN,
      });
      const slow = new (class extends FakeTelegramClient {
        public override async destroy(): Promise<void> {
          await new Promise((resolve) => setTimeout(resolve, 200));
          destroyed = true;
        }
      })(SCOPED_ID);
      await world.startDaemon({
        clientFactory: () => slow as unknown as TelegramClient,
      });
      await world.unlock(PIN);
      await mcp.connect(new SocketClientTransport(world.address(), { v: 1, token }));
      // Builds the account stack, so shutdown has a client to take its time over.
      expect(
        (await mcp.callTool({ name: 'list_dialogs', arguments: {} })).isError,
      ).not.toBe(true);
      await mcp.close();

      const stopping = world.stopDaemon();
      // What the second caller could see the moment it returned.
      const disposing = world.dispose().then(() => destroyed);

      const [, destroyedWhenDisposeReturned] = await Promise.all([stopping, disposing]);

      expect(destroyedWhenDisposeReturned).toBe(true);
      expect(world.exitCodes()).toEqual([0]);
      expect(existsSync(world.dir)).toBe(false);
    } finally {
      await mcp.close().catch(() => undefined);
      await world.dispose().catch(() => undefined);
    }
  }, 30_000);

  it('a disposed world leaves no signal handler of its own behind', async () => {
    const before =
      process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');
    const world = await E2EWorld.create('tmcp-world-c-');
    await world.seal({ config: EMPTY_CONFIG, sessionRefs: ['acct'], pin: PIN });
    await world.startDaemon();
    expect(
      process.listenerCount('SIGINT') + process.listenerCount('SIGTERM'),
    ).toBeGreaterThan(before);

    await world.dispose();

    expect(
      process.listenerCount('SIGINT') + process.listenerCount('SIGTERM'),
    ).toBe(before);
  }, 30_000);
});
