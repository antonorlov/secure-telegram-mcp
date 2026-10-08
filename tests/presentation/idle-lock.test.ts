/**
 * The idle window, end to end. Two things are easy to get wrong and both are load-bearing:
 * work must postpone it — an agent that is using the account should never be cut off — and
 * when it finally fires the worker EXITS rather than sitting there answering `SESSION_LOCKED`,
 * so the Telegram connection and the socket go together.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { connect as netConnect } from 'node:net';
import type { TelegramClient } from 'telegram';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  hashEndpointToken,
  mintEndpointToken,
} from '../../src/infrastructure/endpoint-token.js';
import { SocketClientTransport } from '../_support/socket-mcp-client.js';
import { FakeTelegramClient } from '../_support/fake-telegram-client.js';
import { E2EWorld } from '../_support/e2e-world.js';
import { guardProcessResources } from '../_support/resource-guards.js';

const PIN = 'correct-horse-battery';
const SCOPED_ID = 100;
// ~1.8s, so a case can outlast it deliberately instead of waiting out the shipped 12 hours.
const IDLE_HOURS = '0.0005';
const token = mintEndpointToken();

describe.skipIf(process.platform === 'win32')('the idle window', () => {
  guardProcessResources();
  let world: E2EWorld;
  let fake: FakeTelegramClient;
  let open: Client[];

  beforeEach(async () => {
    open = [];
    fake = new FakeTelegramClient(SCOPED_ID);
    world = await E2EWorld.create('tmcp-idle-');
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
    await world.startDaemon({
      clientFactory: () => fake as unknown as TelegramClient,
      env: { TELEGRAM_MCP_IDLE_HOURS: IDLE_HOURS },
    });
  });
  afterEach(async () => {
    for (const client of open) await client.close().catch(() => undefined);
    await world.dispose();
  });

  const connect = async (): Promise<Client> => {
    const client = new Client({ name: 'idle-test', version: '0.0.0' });
    open.push(client);
    await client.connect(new SocketClientTransport(world.address(), { v: 1, token }));
    return client;
  };

  const read = (client: Client): ReturnType<Client['callTool']> =>
    client.callTool({ name: 'list_dialogs', arguments: {} });

  const isServing = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const probe = netConnect(world.address());
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => {
        resolve(false);
      });
    });

  const exitedWithin = async (ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (world.exitCodes().length > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };

  it('keeps the account open while an agent is working, past the window several times over', async () => {
    await world.unlock(PIN);
    const client = await connect();

    // Six calls spread over roughly three idle windows: each one should push the timer out.
    for (let i = 0; i < 6; i += 1) {
      expect((await read(client)).isError, `call ${String(i)}`).not.toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 900));
    }

    expect(world.exitCodes()).toEqual([]);
    expect(await isServing()).toBe(true);
  }, 30_000);

  it('exits once the work stops, taking the socket with it', async () => {
    await world.unlock(PIN);
    const client = await connect();
    expect((await read(client)).isError).not.toBe(true);

    // Nothing else happens; the window is allowed to close.
    expect(await exitedWithin(15_000)).toBe(true);

    expect(world.exitCodes()).toEqual([0]);
    // Not "up but locked": the process is gone and so is its socket.
    expect(await isServing()).toBe(false);
  }, 30_000);

  it('comes back locked, because the PIN was never on disk to begin with', async () => {
    await world.unlock(PIN);
    expect((await read(await connect())).isError).not.toBe(true);
    expect(await exitedWithin(15_000)).toBe(true);

    await world.startDaemon({
      clientFactory: () => fake as unknown as TelegramClient,
      env: { TELEGRAM_MCP_IDLE_HOURS: IDLE_HOURS },
    });

    const refused = await read(await connect());
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain('SESSION_LOCKED');
  }, 30_000);
});
