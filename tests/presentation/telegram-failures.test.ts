/**
 * What a Telegram failure looks like from the other end of the socket, and what the anti-ban
 * breaker does once this account has been asking for too much. Both are about the daemon
 * staying useful: a mapped, secret-free error for the caller, no false acknowledgement, and a
 * neighbouring account that keeps working throughout.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { TelegramClient } from 'telegram';
import { errors } from 'telegram';
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
const HOME = 100;
// A wide scope, so one un-peered search reserves many units at once: that is what produces a
// back-off long enough to count as a strike against the breaker.
const WIDE = Array.from({ length: 12 }, (_, i) => 1000 + i);

const busyToken = mintEndpointToken();
const calmToken = mintEndpointToken();

const endpoint = (name: string, session: string, token: string, chats: readonly number[]): unknown => ({
  name,
  session,
  scope: { chats: chats.map((id) => String(id)), folders: [] },
  verbs: ['read', 'send'],
  tokenHash: hashEndpointToken(token),
});

describe.skipIf(process.platform === 'win32')('Telegram failures and the anti-ban breaker', () => {
  guardProcessResources();
  let world: E2EWorld;
  let clients: Map<string, FakeTelegramClient>;
  let open: Client[];

  beforeEach(async () => {
    clients = new Map();
    open = [];
    world = await E2EWorld.create('tmcp-failures-');
    await world.seal({
      config: {
        version: 1,
        endpoints: [
          endpoint('busy', 'acct-busy', busyToken, [HOME, ...WIDE]),
          endpoint('calm', 'acct-calm', calmToken, [HOME]),
        ],
      },
      sessionRefs: ['acct-busy', 'acct-calm'],
      pin: PIN,
    });
    await world.startDaemon({
      clientFactory: (sessionRef: string) => {
        const fake = new FakeTelegramClient([HOME, ...WIDE]);
        clients.set(sessionRef, fake);
        return fake as unknown as TelegramClient;
      },
    });
    await world.unlock(PIN);
  });
  afterEach(async () => {
    for (const client of open) await client.close().catch(() => undefined);
    await world.dispose();
    expect(world.exitCodes()).toEqual([0]);
  });

  const connect = async (token: string): Promise<Client> => {
    const client = new Client({ name: 'failures-test', version: '0.0.0' });
    open.push(client);
    await client.connect(new SocketClientTransport(world.address(), { v: 1, token }));
    return client;
  };

  const send = (client: Client, text: string): ReturnType<Client['callTool']> =>
    client.callTool({
      name: 'send_message',
      arguments: { peer: { kind: 'id', value: String(HOME) }, text },
    });

  const search = (client: Client): ReturnType<Client['callTool']> =>
    client.callTool({ name: 'search_messages', arguments: { query: 'anything', limit: 5 } });

  const busyClient = (): FakeTelegramClient => {
    const fake = clients.get('acct-busy');
    if (fake === undefined) throw new Error('the busy account has no client yet');
    return fake;
  };

  describe('a failed request comes back mapped, and the daemon keeps serving', () => {
    it.each([
      [
        'a flood wait',
        'FLOOD_WAIT',
        (): Error => new errors.FloodWaitError({ request: undefined, capture: 42 }),
      ],
      [
        'an unknown peer',
        'NOT_FOUND',
        (): Error => new errors.RPCError('PEER_ID_INVALID', undefined as never, 400),
      ],
      [
        'a plain network failure',
        'GATEWAY_UNAVAILABLE',
        (): Error => new Error('socket hang up'),
      ],
    ])('%s becomes %s without a false ack', async (_label, code, makeError) => {
      const client = await connect(busyToken);
      // One good call first, so the account is open and the failure is the only difference.
      expect((await send(client, 'first')).isError).not.toBe(true);
      busyClient().failNextSend = makeError();

      const failed = await send(client, 'never arrives');

      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed.content)).toContain(code);
      expect(busyClient().sent.map((m) => m.text)).toEqual(['first']);

      // The connection, the account and the daemon all survive it.
      expect((await send(client, 'after')).isError).not.toBe(true);
      const neighbour = await connect(calmToken);
      expect((await send(neighbour, 'unaffected')).isError).not.toBe(true);
    }, 30_000);

    it('carries the retry hint of a flood wait back to the caller', async () => {
      const client = await connect(busyToken);
      expect((await send(client, 'first')).isError).not.toBe(true);
      busyClient().failNextSend = new errors.FloodWaitError({
        request: undefined,
        capture: 42,
      });

      const failed = await send(client, 'never arrives');

      expect(JSON.stringify(failed.content)).toContain('42');
    }, 30_000);
  });

  /**
   * The breaker counts this account's OWN long back-offs, not Telegram's flood waits. Once it
   * trips, every quota-bearing operation on that account is refused for the cooldown: the
   * account stops talking altogether, not only in the bucket it exhausted. That is the point for
   * a Telegram account, where the cost of pushing on is a limited or banned number.
   */
  it('freezes the whole account once its own back-offs trip the breaker, and only that account', async () => {
    const busy = await connect(busyToken);
    const calm = await connect(calmToken);

    // Drain the search budget, then keep asking: every refusal past empty is a strike.
    let refusals = 0;
    for (let attempt = 0; attempt < 20 && refusals < 3; attempt += 1) {
      const result = await search(busy);
      if (result.isError === true) {
        expect(JSON.stringify(result.content)).toContain('QUOTA_EXCEEDED');
        refusals += 1;
      }
    }
    expect(refusals, 'the search budget never ran out').toBe(3);

    // A different bucket on the same account, well inside its own budget — and still refused,
    // by the breaker rather than by the bucket.
    const frozen = await send(busy, 'blocked by the breaker');
    expect(frozen.isError).toBe(true);
    expect(JSON.stringify(frozen.content)).toContain('circuit breaker');
    expect(busyClient().sent).toEqual([]);

    // The other account never asked for anything and is not paying for it.
    expect((await send(calm, 'still fine')).isError).not.toBe(true);
  }, 30_000);
});
