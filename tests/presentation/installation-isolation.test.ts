/**
 * Two installations on one machine. Everything that identifies an installation — the socket,
 * the sealed policy, the sessions, the endpoint keys — hangs off its state directory, so the
 * question is whether anything crosses between them. Nothing may: a key minted for one must be
 * meaningless to the other, and neither may notice the other's shutdown.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

const config = (token: string): unknown => ({
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
});

describe.skipIf(process.platform === 'win32')('two installations on one machine', () => {
  guardProcessResources();
  const tokenA = mintEndpointToken();
  const tokenB = mintEndpointToken();
  let first: E2EWorld;
  let second: E2EWorld;
  let open: Client[];

  const bring = async (world: E2EWorld, token: string): Promise<void> => {
    await world.seal({ config: config(token), sessionRefs: ['acct'], pin: PIN });
    await world.startDaemon({
      clientFactory: () => new FakeTelegramClient(SCOPED_ID) as unknown as TelegramClient,
    });
    await world.unlock(PIN);
  };

  beforeEach(async () => {
    open = [];
    // The second path carries a space, because an operator's home directory often does.
    first = await E2EWorld.create('tmcp-install-a-');
    second = await E2EWorld.create('tmcp install b ');
    await bring(first, tokenA);
    await bring(second, tokenB);
  });
  afterEach(async () => {
    for (const client of open) await client.close().catch(() => undefined);
    await first.dispose();
    await second.dispose();
  });

  const connect = async (world: E2EWorld, token: string): Promise<Client> => {
    const client = new Client({ name: 'isolation-test', version: '0.0.0' });
    open.push(client);
    await client.connect(new SocketClientTransport(world.address(), { v: 1, token }));
    return client;
  };

  const read = (client: Client): ReturnType<Client['callTool']> =>
    client.callTool({ name: 'list_dialogs', arguments: {} });

  it('serves each installation on its own socket, including one whose path has a space', async () => {
    expect(first.address()).not.toBe(second.address());
    expect(second.address()).toContain(' ');

    expect((await read(await connect(first, tokenA))).isError).not.toBe(true);
    expect((await read(await connect(second, tokenB))).isError).not.toBe(true);
  }, 30_000);

  it('refuses a key that belongs to the other installation', async () => {
    await expect(connect(second, tokenA)).rejects.toThrow();
    await expect(connect(first, tokenB)).rejects.toThrow();
  }, 30_000);

  it('leaves the neighbour installation running when one shuts down', async () => {
    const survivor = await connect(second, tokenB);

    await first.stopDaemon();

    expect(first.exitCodes()).toEqual([0]);
    expect(second.exitCodes()).toEqual([]);
    expect((await read(survivor)).isError).not.toBe(true);
  }, 30_000);
});
