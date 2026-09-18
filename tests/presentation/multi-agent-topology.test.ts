/**
 * Topology: several agents on one Telegram account, several accounts on one daemon. What is
 * shared and what is not is a security property — the MTProto connection and the anti-ban quota
 * are per ACCOUNT, while scope, key and revocation are per ENDPOINT. Socket level, with only
 * the Telegram transport faked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { connect as netConnect, type Socket } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
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
// Two chats on the shared account, one per agent; the third agent lives on the second account.
const ALPHA_CHAT = 100;
const BETA_CHAT = 200;
// The daemon's own cap on simultaneously-open shim sockets.
const MAX_CONNECTIONS = 64;
// DEFAULT_QUOTA.messagesPerMin in the daemon: the whole per-account message budget.
const MESSAGES_PER_MIN = 20;

const tokens = {
  alpha: mintEndpointToken(),
  beta: mintEndpointToken(),
  gamma: mintEndpointToken(),
};

const endpoint = (
  name: string,
  session: string,
  chat: number,
  token: string,
): unknown => ({
  name,
  session,
  scope: { chats: [String(chat)], folders: [] },
  verbs: ['read', 'send'],
  tokenHash: hashEndpointToken(token),
});

// Alpha and beta share account 'main'; gamma is a second account entirely.
const configWith = (betaToken: string): unknown => ({
  version: 1,
  endpoints: [
    endpoint('agent-alpha', 'main', ALPHA_CHAT, tokens.alpha),
    endpoint('agent-beta', 'main', BETA_CHAT, betaToken),
    endpoint('agent-gamma', 'work', ALPHA_CHAT, tokens.gamma),
  ],
});

describe.skipIf(process.platform === 'win32')('multi-agent topology', () => {
  guardProcessResources();

  let world: E2EWorld;
  let clients: Map<string, FakeTelegramClient>;
  let factoryCalls: string[];
  let openClients: Client[];
  let openSockets: Socket[];

  beforeEach(async () => {
    clients = new Map();
    factoryCalls = [];
    openClients = [];
    openSockets = [];
    world = await E2EWorld.create('tmcp-topology-');
    await world.seal({
      config: configWith(tokens.beta),
      sessionRefs: ['main', 'work'],
      pin: PIN,
    });
    await world.startDaemon({
      clientFactory: (sessionRef: string) => {
        factoryCalls.push(sessionRef);
        const fake = new FakeTelegramClient([ALPHA_CHAT, BETA_CHAT]);
        clients.set(sessionRef, fake);
        return fake as unknown as TelegramClient;
      },
    });
  });

  afterEach(async () => {
    for (const socket of openSockets) socket.destroy();
    for (const client of openClients) {
      await client.close().catch(() => undefined);
    }
    await world.dispose();
    expect(world.exitCodes()).toEqual([0]);
  });

  const openAgent = async (token: string): Promise<Client> => {
    const client = new Client({ name: 'topology-test', version: '0.0.0' });
    openClients.push(client);
    await client.connect(new SocketClientTransport(world.address(), { v: 1, token }));
    return client;
  };

  const send = (
    agent: Client,
    chat: number,
    text: string,
  ): ReturnType<Client['callTool']> =>
    agent.callTool({
      name: 'send_message',
      arguments: { peer: { kind: 'id', value: String(chat) }, text },
    });

  it('two agents on one account share a single Telegram connection', async () => {
    await world.unlock(PIN);
    const alpha = await openAgent(tokens.alpha);
    const beta = await openAgent(tokens.beta);

    await alpha.callTool({ name: 'list_dialogs', arguments: {} });
    await beta.callTool({ name: 'list_dialogs', arguments: {} });

    expect(factoryCalls).toEqual(['main']);
    expect(clients.get('main')?.connectCalls).toBe(1);
  }, 20_000);

  it('…and stay scope-isolated: neither can act in the other agent\'s chat', async () => {
    await world.unlock(PIN);
    const alpha = await openAgent(tokens.alpha);
    const beta = await openAgent(tokens.beta);

    const trespass = await send(alpha, BETA_CHAT, 'not mine');
    const own = await send(beta, BETA_CHAT, 'mine');

    expect(trespass.isError).toBe(true);
    expect(own.isError).not.toBe(true);
    // The shared client executed the permitted write and nothing else.
    expect(clients.get('main')?.sent.map((m) => m.text)).toEqual(['mine']);
  }, 20_000);

  it('a second account gets its own connection, never the first one\'s', async () => {
    await world.unlock(PIN);
    const alpha = await openAgent(tokens.alpha);
    const gamma = await openAgent(tokens.gamma);

    await alpha.callTool({ name: 'list_dialogs', arguments: {} });
    await gamma.callTool({ name: 'list_dialogs', arguments: {} });

    expect([...factoryCalls].sort()).toEqual(['main', 'work']);
    expect(clients.get('main')).not.toBe(clients.get('work'));
    expect(clients.size).toBe(2);
  }, 20_000);

  it('the anti-ban quota is the account\'s, shared by its agents and not by the other account', async () => {
    await world.unlock(PIN);
    const alpha = await openAgent(tokens.alpha);
    const beta = await openAgent(tokens.beta);
    const gamma = await openAgent(tokens.gamma);

    // Alpha alone spends the whole per-minute message budget of account 'main'.
    for (let i = 0; i < MESSAGES_PER_MIN; i += 1) {
      const result = await send(alpha, ALPHA_CHAT, `burst ${String(i)}`);
      expect(result.isError, `message ${String(i)} of the budget`).not.toBe(true);
    }

    const sibling = await send(beta, BETA_CHAT, 'sibling');
    const otherAccount = await send(gamma, ALPHA_CHAT, 'other account');

    expect(sibling.isError).toBe(true);
    expect(JSON.stringify(sibling)).toContain('QUOTA_EXCEEDED');
    expect(otherAccount.isError).not.toBe(true);
    expect(clients.get('main')?.sent).toHaveLength(MESSAGES_PER_MIN);
    expect(clients.get('work')?.sent.map((m) => m.text)).toEqual(['other account']);
  }, 30_000);

  it('rotating one agent\'s key revokes its live connection and leaves its sibling working', async () => {
    const operator: OperatorClient = await world.unlock(PIN);
    const alpha = await openAgent(tokens.alpha);
    const beta = await openAgent(tokens.beta);
    expect((await send(beta, BETA_CHAT, 'before')).isError).not.toBe(true);

    const rotated = mintEndpointToken();
    const applied = await operator.applyPolicy(
      JSON.stringify(configWith(rotated)),
    );
    expect(applied.ok).toBe(true);

    // The key presented at handshake no longer matches the enforced hash, and it is re-checked
    // per call — so the already-open connection stops working without reconnecting.
    const revoked = await send(beta, BETA_CHAT, 'after');
    expect(revoked.isError).toBe(true);
    expect(JSON.stringify(revoked)).toContain('revoked');
    expect((await send(alpha, ALPHA_CHAT, 'still fine')).isError).not.toBe(true);
    expect(clients.get('main')?.sent.map((m) => m.text)).toEqual([
      'before',
      'still fine',
    ]);
  }, 20_000);

  it('a fresh connection with the rotated-away key is refused at the handshake', async () => {
    const operator: OperatorClient = await world.unlock(PIN);
    expect(
      (await operator.applyPolicy(JSON.stringify(configWith(mintEndpointToken()))))
        .ok,
    ).toBe(true);

    await expect(openAgent(tokens.beta)).rejects.toThrow();
  }, 20_000);

  /**
   * The replay cache lives on the scoped binding, so it de-duplicates a retry by the SAME agent
   * and nothing else. Two agents that happen to choose the same key are two different senders,
   * and swallowing one of their messages would be worse than sending twice.
   */
  describe('an idempotency key belongs to one binding', () => {
    const sendWithKey = (
      agent: Client,
      chat: number,
      text: string,
      idempotencyKey: string,
    ): ReturnType<Client['callTool']> =>
      agent.callTool({
        name: 'send_message',
        arguments: {
          peer: { kind: 'id', value: String(chat) },
          text,
          idempotencyKey,
        },
      });

    it('replays the first result for a repeat from the same agent, without sending twice', async () => {
      await world.unlock(PIN);
      const alpha = await openAgent(tokens.alpha);

      const first = await sendWithKey(alpha, ALPHA_CHAT, 'once', 'retry-key-1');
      const second = await sendWithKey(alpha, ALPHA_CHAT, 'once', 'retry-key-1');

      expect(first.isError).not.toBe(true);
      expect(second.isError).not.toBe(true);
      expect(second.structuredContent).toEqual(first.structuredContent);
      expect(clients.get('main')?.sent.map((m) => m.text)).toEqual(['once']);
    }, 20_000);

    it('does not let one agent\'s key swallow another agent\'s message', async () => {
      await world.unlock(PIN);
      const alpha = await openAgent(tokens.alpha);
      const beta = await openAgent(tokens.beta);

      const mine = await sendWithKey(alpha, ALPHA_CHAT, 'from alpha', 'shared-key');
      const theirs = await sendWithKey(beta, BETA_CHAT, 'from beta', 'shared-key');

      expect(mine.isError).not.toBe(true);
      expect(theirs.isError).not.toBe(true);
      // Same key text, same account, different bindings: both messages went out.
      expect(clients.get('main')?.sent.map((m) => m.text)).toEqual([
        'from alpha',
        'from beta',
      ]);
    }, 20_000);
  });

  it('a media handle is the minting agent\'s alone — its sibling on the same account cannot redeem it', async () => {
    await world.unlock(PIN);
    await mkdir(world.mediaDir, { recursive: true });
    const localPath = join(world.mediaDir, 'report.txt');
    await writeFile(localPath, 'payload', 'utf8');
    const alpha = await openAgent(tokens.alpha);
    const beta = await openAgent(tokens.beta);

    const prepared = await alpha.callTool({
      name: 'prepare_media',
      arguments: { localPath },
    });
    expect(prepared.isError).not.toBe(true);
    const handle = (prepared.structuredContent as { readonly handle: string }).handle;

    // Beta may write in its own chat and holds a valid handle string — the handle is still
    // unknown to its own scoped binding, so the upload never happens.
    const stolen = await beta.callTool({
      name: 'send_media',
      arguments: { peer: { kind: 'id', value: String(BETA_CHAT) }, handle },
    });
    expect(stolen.isError).toBe(true);
    expect(clients.get('main')?.sent).toEqual([]);

    // The minting agent redeems the same handle, so the refusal above was about ownership.
    const own = await alpha.callTool({
      name: 'send_media',
      arguments: {
        peer: { kind: 'id', value: String(ALPHA_CHAT) },
        handle,
        caption: 'mine to send',
      },
    });
    expect(own.isError).not.toBe(true);
    expect(clients.get('main')?.sent.map((m) => m.text)).toEqual(['mine to send']);
  }, 20_000);

  it(`admits ${String(MAX_CONNECTIONS)} agent sockets, drops the next, and takes it back after one disconnects`, async () => {
    await world.unlock(PIN);

    // A handshake is enough to hold a slot; these sockets never speak MCP.
    const hold = async (): Promise<Socket> => {
      const socket = netConnect(world.address());
      openSockets.push(socket);
      socket.on('error', () => undefined);
      await once(socket, 'connect');
      socket.write(`${JSON.stringify({ v: 1, token: tokens.alpha })}\n`);
      return socket;
    };
    // Resolves true when the daemon hangs up inside the window, false when the socket lives.
    const droppedWithin = async (socket: Socket, ms: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          resolve(false);
        }, ms);
        socket.once('close', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

    const held: Socket[] = [];
    const heldAt = (index: number): Socket => {
      const socket = held[index];
      if (socket === undefined) throw new Error(`no held socket at ${String(index)}`);
      return socket;
    };
    for (let i = 0; i < MAX_CONNECTIONS; i += 1) held.push(await hold());
    expect(await droppedWithin(heldAt(0), 100)).toBe(false);

    expect(await droppedWithin(await hold(), 1000)).toBe(true);

    const freed = heldAt(held.length - 1);
    held.pop();
    freed.destroy();
    await once(freed, 'close');
    expect(await droppedWithin(await hold(), 300)).toBe(false);
  }, 30_000);
});
