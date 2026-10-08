import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';

import {
  operatorAddress,
} from '../../src/infrastructure/index.js';
import { OperatorClient } from '../../src/presentation/operator/client.js';

const requestId = (chunk: Buffer): string =>
  (JSON.parse(chunk.toString('utf8').trim()) as { readonly id: string }).id;

describe.skipIf(process.platform === 'win32')('OperatorClient framing', () => {
  let sessionDir: string;
  let server: Server | undefined;
  let client: OperatorClient | undefined;

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), 'tmcp-operator-client-'));
  });

  afterEach(async () => {
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
            result: { posture: 'smooth', locked: false, hasAccounts: true },
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
      value: { posture: 'smooth', locked: false, hasAccounts: true },
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
});
