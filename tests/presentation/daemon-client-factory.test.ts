// The seam that lets a socket-level test reach a tool result instead of GATEWAY_UNAVAILABLE:
// a call reaches the injected client, each account gets its own, and retiring one destroys it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { TelegramClient } from 'telegram';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  hashEndpointToken,
  mintEndpointToken,
} from '../../src/infrastructure/endpoint-token.js';
import type { OperatorClient } from '../../src/presentation/operator/client.js';
import { SocketClientTransport } from '../_support/socket-mcp-client.js';
import { FakeTelegramClient } from '../_support/fake-telegram-client.js';
import { E2EWorld } from '../_support/e2e-world.js';
import { guardProcessResources } from '../_support/resource-guards.js';

const PIN = 'correct-horse-battery';
const SCOPED_ID = 100;

const endpoint = (name: string, session: string, token: string): unknown => ({
  name,
  session,
  scope: { chats: [String(SCOPED_ID)], folders: [] },
  verbs: ['read'],
  tokenHash: hashEndpointToken(token),
});

describe.skipIf(process.platform === 'win32')(
  'daemon clientFactory seam (socket level)',
  () => {
    const tokenA = mintEndpointToken();
    const tokenB = mintEndpointToken();
    let world: E2EWorld;
    let clients: Map<string, FakeTelegramClient>;
    let factoryCalls: string[];
    let openClients: Client[];
    // Makes the next client construction fail, the way a first dial to Telegram can.
    let failNextOpen: boolean;
    guardProcessResources();

    beforeEach(async () => {
      clients = new Map();
      factoryCalls = [];
      openClients = [];
      failNextOpen = false;
      world = await E2EWorld.create('tmcp-factory-');
      await world.seal({
        config: {
          version: 1,
          endpoints: [
            endpoint('reader-a', 'acct-a', tokenA),
            endpoint('reader-b', 'acct-b', tokenB),
          ],
        },
        sessionRefs: ['acct-a', 'acct-b'],
        pin: PIN,
      });
      await world.startDaemon({
        clientFactory: (sessionRef: string) => {
          factoryCalls.push(sessionRef);
          if (failNextOpen) {
            failNextOpen = false;
            throw new Error('synthetic dial failure');
          }
          const fake = new FakeTelegramClient(SCOPED_ID);
          clients.set(sessionRef, fake);
          return fake as unknown as TelegramClient;
        },
      });
    });
    afterEach(async () => {
      for (const client of openClients) {
        await client.close().catch(() => undefined);
      }
      await world.dispose();
      expect(world.exitCodes()).toEqual([0]);
    });

    const openMcp = async (token: string): Promise<Client> => {
      const client = new Client({ name: 'factory-test', version: '0.0.0' });
      openClients.push(client);
      await client.connect(
        new SocketClientTransport(world.address(), { v: 1, token }),
      );
      return client;
    };

    it('a tool call crosses the socket and reaches the injected client', async () => {
      await world.unlock(PIN);
      const mcp = await openMcp(tokenA);

      const result = await mcp.callTool({ name: 'list_dialogs', arguments: {} });

      expect(result.isError).not.toBe(true);
      expect(factoryCalls).toEqual(['acct-a']);
      expect(clients.get('acct-a')?.connectCalls).toBe(1);
    }, 20_000);

    it('each account gets its own client, keyed by sessionRef', async () => {
      await world.unlock(PIN);
      const a = await openMcp(tokenA);
      const b = await openMcp(tokenB);

      expect(
        (await a.callTool({ name: 'list_dialogs', arguments: {} })).isError,
      ).not.toBe(true);
      expect(
        (await b.callTool({ name: 'list_dialogs', arguments: {} })).isError,
      ).not.toBe(true);

      expect([...factoryCalls].sort()).toEqual(['acct-a', 'acct-b']);
      expect(clients.get('acct-a')).not.toBe(clients.get('acct-b'));
    }, 20_000);

    it('does not cache a failed account open: the next call dials again', async () => {
      await world.unlock(PIN);
      const mcp = await openMcp(tokenA);
      failNextOpen = true;

      const failed = await mcp.callTool({ name: 'list_dialogs', arguments: {} });

      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed.content)).toContain('GATEWAY_UNAVAILABLE');
      expect(clients.has('acct-a')).toBe(false);

      // A broken first dial must not become a permanent state for the account.
      const recovered = await mcp.callTool({ name: 'list_dialogs', arguments: {} });

      expect(recovered.isError).not.toBe(true);
      expect(factoryCalls).toEqual(['acct-a', 'acct-a']);
      expect(clients.get('acct-a')?.connectCalls).toBe(1);
    }, 20_000);

    it('leaves the other account answering when one is removed under live clients', async () => {
      const operator: OperatorClient = await world.unlock(PIN);
      const a = await openMcp(tokenA);
      const b = await openMcp(tokenB);
      expect((await a.callTool({ name: 'list_dialogs', arguments: {} })).isError).not.toBe(true);
      expect((await b.callTool({ name: 'list_dialogs', arguments: {} })).isError).not.toBe(true);

      expect((await operator.removeAccount('acct-a')).ok).toBe(true);

      const orphaned = await a.callTool({ name: 'list_dialogs', arguments: {} });
      expect(orphaned.isError).toBe(true);
      // The neighbour is asked to do real work, not merely observed to be undestroyed.
      const neighbour = await b.callTool({ name: 'list_dialogs', arguments: {} });
      expect(neighbour.isError).not.toBe(true);
      expect(JSON.stringify(neighbour.structuredContent)).toContain(String(SCOPED_ID));
    }, 20_000);

    it('retiring one account destroys only that account client', async () => {
      const operator: OperatorClient = await world.unlock(PIN);
      const a = await openMcp(tokenA);
      const b = await openMcp(tokenB);
      await a.callTool({ name: 'list_dialogs', arguments: {} });
      await b.callTool({ name: 'list_dialogs', arguments: {} });

      expect((await operator.removeAccount('acct-a')).ok).toBe(true);

      expect(clients.get('acct-a')?.destroyCalls).toBeGreaterThanOrEqual(1);
      expect(clients.get('acct-b')?.destroyCalls).toBe(0);
    }, 20_000);
  },
);
