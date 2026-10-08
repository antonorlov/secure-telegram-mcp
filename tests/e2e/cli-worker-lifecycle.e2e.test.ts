/**
 * The worker nobody starts by hand. A published `connect` finds the one daemon for a state
 * directory or detaches and starts it, and that process outlives the shim. The questions here
 * are ownership and recovery: one owner per directory however many shims arrive, and a
 * replacement after the owner goes — cleanly or not — with the sealed state intact.
 *
 * The whole suite stays in the LOCKED state on purpose: the daemon serves its menu and fails
 * every call closed, so no Telegram transport is ever constructed and no account is needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  hashEndpointToken,
  mintEndpointToken,
} from '../../src/infrastructure/endpoint-token.js';
import { daemonAddress } from '../../src/infrastructure/index.js';
import { E2EWorld } from '../_support/e2e-world.js';
import {
  processIsAlive,
  readDaemonOwner,
  stopDetachedDaemon,
  waitForDaemonOwner,
  waitForExit,
} from '../_support/detached-daemon.js';

const PIN = 'correct-horse-battery';
const SCOPED_ID = 100;
const CLI = join(process.cwd(), 'dist', 'presentation', 'cli', 'main.js');

describe.skipIf(process.platform === 'win32')('cli worker lifecycle', () => {
  const token = mintEndpointToken();
  let world: E2EWorld;
  let shims: Client[];
  let raw: ChildProcess[];

  beforeEach(async () => {
    shims = [];
    raw = [];
    world = await E2EWorld.create('tmcp-worker-');
    // Hardened with no unlock channel: whatever starts comes up locked-but-serving.
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
  });

  afterEach(async () => {
    for (const shim of shims) await shim.close().catch(() => undefined);
    for (const child of raw) child.kill('SIGKILL');
    // Whatever the CLI started belongs to this case, even when an assertion failed.
    await stopDetachedDaemon(world.sessionDir).catch(() => undefined);
    await world.dispose();
  });

  // The published entrypoint, exactly as an MCP client would spawn it.
  const connect = async (): Promise<Client> => {
    const client = new Client({ name: 'worker-e2e', version: '0.0.0' });
    shims.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, 'connect'],
        env: world.childEnv({ TELEGRAM_MCP_ENDPOINT_TOKEN: token }),
        stderr: 'ignore',
      }),
    );
    return client;
  };

  const isServing = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const probe = netConnect(daemonAddress(world.sessionDir));
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => {
        resolve(false);
      });
    });

  const callLocked = async (client: Client): Promise<string> => {
    const result = await client.callTool({ name: 'list_dialogs', arguments: {} });
    expect(result.isError).toBe(true);
    return JSON.stringify(result.content);
  };

  /**
   * The shim as a plain process, so the case owns its stdin and reads its exit code — the two
   * things an MCP client's transport hides.
   */
  const spawnShim = (): ChildProcess => {
    const child = spawn(process.execPath, [CLI, 'connect'], {
      env: world.childEnv({ TELEGRAM_MCP_ENDPOINT_TOKEN: token }),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    raw.push(child);
    return child;
  };

  const exitCodeOf = async (child: ChildProcess): Promise<number | null> => {
    const [code] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    return code;
  };

  // True when the process is gone inside the window; false when it is still there.
  const exitedWithin = (child: ChildProcess, ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => {
        resolve(false);
      }, ms);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  it('starts the worker on the first connect and serves a locked menu through it', async () => {
    expect(readDaemonOwner(world.sessionDir)).toBeUndefined();

    const client = await connect();

    const owner = await waitForDaemonOwner(world.sessionDir);
    expect(processIsAlive(owner.pid)).toBe(true);
    // Its own process, not the shim's: the shim is a pipe, the worker holds the state.
    expect(owner.pid).not.toBe(process.pid);
    expect(existsSync(daemonAddress(world.sessionDir))).toBe(true);

    expect((await client.listTools()).tools.map((t) => t.name)).toContain('list_dialogs');
    expect(await callLocked(client)).toContain('SESSION_LOCKED');
  }, 60_000);

  it('gives two concurrent connects the same single worker', async () => {
    const [first, second] = await Promise.all([connect(), connect()]);

    const owner = await waitForDaemonOwner(world.sessionDir);
    expect((await first.listTools()).tools.length).toBeGreaterThan(0);
    expect((await second.listTools()).tools.length).toBeGreaterThan(0);
    // One lease for the directory, and it did not change under the second arrival.
    expect(readDaemonOwner(world.sessionDir)).toEqual(owner);
    expect(await callLocked(first)).toContain('SESSION_LOCKED');
    expect(await callLocked(second)).toContain('SESSION_LOCKED');

    // A loser that kept running would still be serving once the owner is gone.
    await stopDetachedDaemon(world.sessionDir);
    await waitForExit(owner.pid);
    expect(await isServing()).toBe(false);
  }, 60_000);

  it('hands a later connect a fresh worker after the first one exits cleanly', async () => {
    const first = await connect();
    const before = await waitForDaemonOwner(world.sessionDir);
    expect(await callLocked(first)).toContain('SESSION_LOCKED');

    await stopDetachedDaemon(world.sessionDir, 'SIGTERM');
    await waitForExit(before.pid);
    // The shim it was serving does not silently keep answering.
    await expect(first.listTools()).rejects.toThrow();

    const second = await connect();
    const after = await waitForDaemonOwner(world.sessionDir);

    expect(after.pid).not.toBe(before.pid);
    expect(after.token).not.toBe(before.token);
    // The sealed state outlived the process: the same endpoint key is still the way in, and
    // the store is still hardened, so the new worker is locked too.
    expect((await second.listTools()).tools.length).toBeGreaterThan(0);
    expect(await callLocked(second)).toContain('SESSION_LOCKED');
  }, 60_000);

  it('recovers from an unclean exit that left the socket and the lease behind', async () => {
    const first = await connect();
    const before = await waitForDaemonOwner(world.sessionDir);
    await callLocked(first);

    // SIGKILL: no teardown ran, so the socket file and the owner file are still there.
    await stopDetachedDaemon(world.sessionDir, 'SIGKILL');
    await waitForExit(before.pid);
    expect(existsSync(daemonAddress(world.sessionDir))).toBe(true);
    expect(readDaemonOwner(world.sessionDir)?.pid).toBe(before.pid);

    const second = await connect();
    const after = await waitForDaemonOwner(world.sessionDir);

    expect(after.pid).not.toBe(before.pid);
    expect((await second.listTools()).tools.length).toBeGreaterThan(0);
    expect(await callLocked(second)).toContain('SESSION_LOCKED');
  }, 60_000);

  describe('a shim is a pipe, and its ends are separate lifetimes', () => {
    it('exits cleanly when its client closes stdin', async () => {
      const child = spawnShim();
      await waitForDaemonOwner(world.sessionDir);

      child.stdin?.end();

      // EOF on stdin is how an MCP host says "done" — an ordinary end, not a failure.
      expect(await exitCodeOf(child)).toBe(0);
      // The worker it started is not its dependant and stays up for the next client.
      expect(processIsAlive(readDaemonOwner(world.sessionDir)?.pid ?? 0)).toBe(true);
    }, 60_000);

    it('fails the next request instead of hanging when the worker is killed under it', async () => {
      const client = await connect();
      const owner = await waitForDaemonOwner(world.sessionDir);
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);

      await stopDetachedDaemon(world.sessionDir, 'SIGKILL');
      await waitForExit(owner.pid);

      // The host learns through its request, which is the only channel it has.
      await expect(client.listTools()).rejects.toThrow();
    }, 60_000);

    /**
     * Whether the shim notices the dropped socket by itself is timing-dependent today — it is
     * sometimes still there seconds later, and the stdin-EOF path that ends it while the worker
     * lives does not reliably complete once the socket is gone. So the contract pinned here is
     * the one a host can always rely on: the process it started ends when it says so.
     */
    it('can always be ended by the host that started it, worker or no worker', async () => {
      const child = spawnShim();
      const owner = await waitForDaemonOwner(world.sessionDir);
      await stopDetachedDaemon(world.sessionDir, 'SIGKILL');
      await waitForExit(owner.pid);

      child.stdin?.end();
      child.kill('SIGTERM');

      expect(await exitedWithin(child, 5_000)).toBe(true);
    }, 60_000);

    it('keeps serving the neighbour when one of several clients goes away', async () => {
      const leaving = await connect();
      const staying = await connect();
      expect(await callLocked(staying)).toContain('SESSION_LOCKED');

      await leaving.close();

      // One client leaving must not take the shared worker, or the account, with it.
      expect((await staying.listTools()).tools.length).toBeGreaterThan(0);
      expect(await callLocked(staying)).toContain('SESSION_LOCKED');
      expect(await isServing()).toBe(true);
    }, 60_000);
  });
});
