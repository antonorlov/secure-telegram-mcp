import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';

import {
  operatorAddress,
} from '../../src/infrastructure/index.js';
import { OperatorClient } from '../../src/presentation/operator/client.js';
import { processIsAlive, writeDaemonOwner } from '../_support/detached-daemon.js';

const requestId = (chunk: Buffer): string =>
  (JSON.parse(chunk.toString('utf8').trim()) as { readonly id: string }).id;

describe.skipIf(process.platform === 'win32')('OperatorClient framing', () => {
  let sessionDir: string;
  let server: Server | undefined;
  let client: OperatorClient | undefined;
  let children: ChildProcess[];

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'tmcp-operator-client-'));
    children = [];
  });

  afterEach(async () => {
    for (const child of children) child.kill('SIGKILL');
    client?.close();
    if (server !== undefined) {
      const runningServer = server;
      await new Promise<void>((resolve) => {
        runningServer.close(() => {
          resolve();
        });
      });
    }
    await rm(sessionDir, { recursive: true, force: true });
  });

  const listen = async (onConnection: (socket: Socket) => void): Promise<void> => {
    server = createServer(onConnection);
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(operatorAddress(sessionDir), resolve);
    });
    client = new OperatorClient({
      sessionDir,
      daemonCommand: { execPath: '/unused', args: [] },
    });
    expect((await client.connect()).ok).toBe(true);
  };

  it('preserves multibyte account labels split across socket chunks', async () => {
    await listen((socket) => {
      socket.once('data', (chunk: Buffer) => {
        const frame = Buffer.from(
          `${JSON.stringify({
            v: 1,
            id: requestId(chunk),
            ok: true,
            result: {
              accounts: [{ sessionRef: 'main', label: 'Jose 🚀' }],
            },
          })}\n`,
          'utf8',
        );
        const marker = frame.indexOf(Buffer.from('🚀', 'utf8'));
        socket.write(frame.subarray(0, marker + 1));
        setImmediate(() => socket.write(frame.subarray(marker + 1)));
      });
    });

    const listed = await client?.listAccounts();

    expect(listed).toEqual({
      ok: true,
      value: { accounts: [{ sessionRef: 'main', label: 'Jose 🚀' }] },
    });
  });

  it('drops a partial frame before reconnecting', async () => {
    let connections = 0;
    await listen((socket) => {
      connections += 1;
      socket.once('data', (chunk: Buffer) => {
        if (connections === 1) {
          socket.write('{"v":1');
          socket.destroy();
          return;
        }
        socket.write(
          `${JSON.stringify({
            v: 1,
            id: requestId(chunk),
            ok: true,
            result: { posture: 'smooth', locked: false, hasAccounts: true, version: '1.2.3' },
          })}\n`,
        );
      });
    });

    expect((await client?.status())?.ok).toBe(false);
    expect((await client?.connect())?.ok).toBe(true);
    const status = await Promise.race([
      client?.status(),
      new Promise<undefined>((resolve) => {
        setTimeout(() => {
          resolve(undefined);
        }, 500);
      }),
    ]);

    expect(status).toEqual({
      ok: true,
      value: { posture: 'smooth', locked: false, hasAccounts: true, version: '1.2.3' },
    });
  });

  it('settles pending work and closes on a malformed response', async () => {
    await listen((socket) => {
      socket.once('data', () => { socket.write('null\n'); });
    });

    expect(await client?.status()).toEqual({
      ok: false,
      error: 'malformed operator response',
    });
    expect(await client?.status()).toEqual({
      ok: false,
      error: 'operator client is not connected',
    });
  });

  it('refuses a valid result shape belonging to another operation', async () => {
    await listen((socket) => {
      socket.once('data', (chunk: Buffer) => {
        socket.write(
          `${JSON.stringify({
            v: 1,
            id: requestId(chunk),
            ok: true,
            result: { changed: true },
          })}\n`,
        );
      });
    });

    expect(await client?.status()).toEqual({
      ok: false,
      error: 'operator response did not match its request',
    });
  });

  it('never starts a daemon just to stop it', async () => {
    const marker = join(sessionDir, 'spawned');
    client = new OperatorClient({
      sessionDir,
      daemonCommand: {
        execPath: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`],
      },
    });

    expect(await client.stop()).toEqual({ ok: true, value: 'not-running' });
    expect(existsSync(marker)).toBe(false);
  });

  it('reports a stop only once the daemon process has exited', async () => {
    // Stands in for the detached worker: the process the lease names as the socket's owner.
    const daemon = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
      stdio: 'ignore',
    });
    children.push(daemon);
    const pid = daemon.pid;
    if (pid === undefined) throw new Error('the stand-in daemon did not start');
    await writeDaemonOwner(sessionDir, pid);
    let requested: unknown;
    await listen((socket) => {
      socket.once('data', (chunk: Buffer) => {
        requested = JSON.parse(chunk.toString('utf8'));
        socket.end(
          `${JSON.stringify({
            v: 1,
            id: requestId(chunk),
            ok: true,
            result: { accepted: true },
          })}\n`,
        );
        // A real daemon drains Telegram before it exits; this one takes a moment too.
        setTimeout(() => { daemon.kill('SIGTERM'); }, 300);
      });
    });

    const stopped = await client?.stop();

    expect(requested).toMatchObject({ op: 'stop' });
    expect(stopped).toEqual({ ok: true, value: 'stopped' });
    expect(processIsAlive(pid)).toBe(false);
  });
});
