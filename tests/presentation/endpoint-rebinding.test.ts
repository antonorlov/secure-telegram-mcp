/**
 * What happens to an endpoint that stops existing, or starts belonging to another account.
 * Both are ordinary operator edits and both change who may act where, so each is checked on a
 * connection that is already open as well as on a fresh one — and against a sibling endpoint
 * that must not notice.
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

const moverToken = mintEndpointToken();
const keeperToken = mintEndpointToken();

const endpoint = (name: string, session: string, token: string): unknown => ({
  name,
  session,
  scope: { chats: [String(SCOPED_ID)], folders: [] },
  verbs: ['read'],
  tokenHash: hashEndpointToken(token),
});

const policy = (movers: readonly unknown[]): string =>
  JSON.stringify({
    version: 1,
    endpoints: [...movers, endpoint('keeper', 'acct-b', keeperToken)],
  });

describe.skipIf(process.platform === 'win32')('endpoint removal and rebinding', () => {
  guardProcessResources();
  let world: E2EWorld;
  let clients: Map<string, FakeTelegramClient>;
  let factoryCalls: string[];
  let open: Client[];

  beforeEach(async () => {
    clients = new Map();
    factoryCalls = [];
    open = [];
    world = await E2EWorld.create('tmcp-rebind-');
    await world.seal({
      config: JSON.parse(policy([endpoint('mover', 'acct-a', moverToken)])) as unknown,
      sessionRefs: ['acct-a', 'acct-b'],
      pin: PIN,
    });
    await world.startDaemon({
      clientFactory: (sessionRef: string) => {
        factoryCalls.push(sessionRef);
        const fake = new FakeTelegramClient(SCOPED_ID);
        clients.set(sessionRef, fake);
        return fake as unknown as TelegramClient;
      },
    });
  });
  afterEach(async () => {
    for (const client of open) await client.close().catch(() => undefined);
    await world.dispose();
    expect(world.exitCodes()).toEqual([0]);
  });

  const connect = async (token: string): Promise<Client> => {
    const client = new Client({ name: 'rebind-test', version: '0.0.0' });
    open.push(client);
    await client.connect(new SocketClientTransport(world.address(), { v: 1, token }));
    return client;
  };

  const read = (client: Client): ReturnType<Client['callTool']> =>
    client.callTool({ name: 'list_dialogs', arguments: {} });

  it('stops serving an endpoint the operator removed, on the open connection and on a new one', async () => {
    const operator = await world.unlock(PIN);
    const mover = await connect(moverToken);
    const keeper = await connect(keeperToken);
    expect((await read(mover)).isError).not.toBe(true);

    expect((await operator.applyPolicy(policy([]))).ok).toBe(true);

    /**
     * Fail-closed, and NOT the code a rotated key produces: the endpoint is gone from the
     * enforced menu entirely, so the daemon cannot say anything about it beyond "not
     * available" — which is what `SESSION_LOCKED` means on this surface.
     */
    const refused = await read(mover);
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain('SESSION_LOCKED');
    // A fresh client with the same key cannot even hand shake.
    await expect(connect(moverToken)).rejects.toThrow();
    // The sibling never noticed.
    expect((await read(keeper)).isError).not.toBe(true);
  }, 30_000);

  it('sends a rebound endpoint to the account it now belongs to', async () => {
    const operator = await world.unlock(PIN);
    const mover = await connect(moverToken);
    expect((await read(mover)).isError).not.toBe(true);
    expect(factoryCalls).toEqual(['acct-a']);

    expect(
      (await operator.applyPolicy(policy([endpoint('mover', 'acct-b', moverToken)]))).ok,
    ).toBe(true);

    expect((await read(mover)).isError).not.toBe(true);
    // The second account's connection was opened for it; the first is not reused.
    expect(factoryCalls).toEqual(['acct-a', 'acct-b']);
    expect(clients.get('acct-b')?.connectCalls).toBe(1);
  }, 30_000);

  it('keeps the sibling endpoint bound to its own account through the rebind', async () => {
    const operator = await world.unlock(PIN);
    const keeper = await connect(keeperToken);
    expect((await read(keeper)).isError).not.toBe(true);

    expect(
      (await operator.applyPolicy(policy([endpoint('mover', 'acct-b', moverToken)]))).ok,
    ).toBe(true);
    const mover = await connect(moverToken);
    expect((await read(mover)).isError).not.toBe(true);

    // Both endpoints now ride account B's one connection: per account, not per endpoint.
    expect(factoryCalls).toEqual(['acct-b']);
    expect(clients.size).toBe(1);
  }, 30_000);
});
