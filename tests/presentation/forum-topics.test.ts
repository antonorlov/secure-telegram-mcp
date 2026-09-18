/**
 * A forum supergroup is a chat with chats inside it, and the topic is the part most likely to
 * be lost in translation: it travels as JSON from the client, through the use case, into the
 * MTProto request. Scope is still per CHAT — a topic refines where a message lands, it does not
 * widen what the endpoint may touch.
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
const PLAIN_CHAT = 100;
const FORUM_CHANNEL = 1234567;
// How a channel is addressed everywhere outside MTProto.
const FORUM_PEER = `-100${String(FORUM_CHANNEL)}`;
const TOPIC = FakeTelegramClient.TOPIC_ID;

const token = mintEndpointToken();

const policy = (chats: readonly string[]): unknown => ({
  version: 1,
  endpoints: [
    {
      name: 'worker',
      session: 'acct',
      scope: { chats: [...chats], folders: [] },
      verbs: ['read', 'send'],
      tokenHash: hashEndpointToken(token),
    },
  ],
});

describe.skipIf(process.platform === 'win32')('forum topics through the daemon', () => {
  guardProcessResources();
  let world: E2EWorld;
  let fake: FakeTelegramClient;
  let open: Client[];

  beforeEach(async () => {
    open = [];
    fake = new FakeTelegramClient(PLAIN_CHAT, FORUM_CHANNEL);
    world = await E2EWorld.create('tmcp-forum-');
  });
  afterEach(async () => {
    for (const client of open) await client.close().catch(() => undefined);
    await world.dispose();
    expect(world.exitCodes()).toEqual([0]);
  });

  const start = async (chats: readonly string[]): Promise<Client> => {
    await world.seal({ config: policy(chats), sessionRefs: ['acct'], pin: PIN });
    await world.startDaemon({
      clientFactory: () => fake as unknown as TelegramClient,
    });
    await world.unlock(PIN);
    const client = new Client({ name: 'forum-test', version: '0.0.0' });
    open.push(client);
    await client.connect(new SocketClientTransport(world.address(), { v: 1, token }));
    return client;
  };

  const listTopics = (client: Client, peer: string): ReturnType<Client['callTool']> =>
    client.callTool({
      name: 'list_topics',
      arguments: { peer: { kind: 'id', value: peer } },
    });

  const sendTo = (
    client: Client,
    peer: string,
    topicId?: number,
    replyToMessageId?: number,
  ): ReturnType<Client['callTool']> =>
    client.callTool({
      name: 'send_message',
      arguments: {
        peer: { kind: 'id', value: peer },
        text: 'into the topic',
        ...(topicId !== undefined ? { topicId } : {}),
        ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
      },
    });

  it('lists the topics of an in-scope forum', async () => {
    const client = await start([FORUM_PEER]);

    const result = await listTopics(client, FORUM_PEER);

    expect(result.isError).not.toBe(true);
    const payload = JSON.stringify(result.structuredContent);
    expect(payload).toContain(String(TOPIC));
    expect(payload).toContain('Releases');
  }, 30_000);

  it('carries the topic id all the way into the Telegram request', async () => {
    const client = await start([FORUM_PEER]);

    const result = await sendTo(client, FORUM_PEER, TOPIC);

    expect(result.isError).not.toBe(true);
    expect(fake.sent).toHaveLength(1);
    /**
     * Not merely "a message was sent": it was addressed to the topic. A topic on its own is
     * the root message it replies to — `topMsgId` is what MTProto wants only when there is a
     * real reply as well, which the next case covers.
     */
    expect(fake.sent[0]?.replyTo).toBe(TOPIC);
    expect(fake.sent[0]?.topMsgId).toBeUndefined();
  }, 30_000);

  it('keeps the topic and the reply apart when a message answers another inside a topic', async () => {
    const client = await start([FORUM_PEER]);

    const result = await sendTo(client, FORUM_PEER, TOPIC, 991);

    expect(result.isError).not.toBe(true);
    expect(fake.sent[0]?.replyTo).toBe(991);
    expect(fake.sent[0]?.topMsgId).toBe(TOPIC);
  }, 30_000);

  it('refuses a forum that is out of scope, topic or no topic', async () => {
    const client = await start([String(PLAIN_CHAT)]);

    expect((await listTopics(client, FORUM_PEER)).isError).toBe(true);
    expect((await sendTo(client, FORUM_PEER, TOPIC)).isError).toBe(true);
    expect(fake.sent).toEqual([]);
  }, 30_000);

  it('refuses topics on a chat that is not a forum, without a round trip', async () => {
    const client = await start([String(PLAIN_CHAT)]);

    const result = await listTopics(client, String(PLAIN_CHAT));

    expect(result.isError).toBe(true);
    // A plain chat has no topics to list; the endpoint may read it all the same.
    expect(
      (await client.callTool({ name: 'list_dialogs', arguments: {} })).isError,
    ).not.toBe(true);
  }, 30_000);
});
