/**
 * A folder in scope is not a list of chats copied at save time — it is a live unit, resolved
 * when the binding is built. That is the whole difference between "these five chats" and "my
 * Work folder", and it is the part an operator cannot see from the config file alone.
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
const INSIDE = 100;
const JOINING = 200;
const OUTSIDE = 300;
const FOLDER_ID = 7;
const FOLDER_TITLE = 'Work';

const token = mintEndpointToken();

const policy = (folders: readonly (number | string)[]): unknown => ({
  version: 1,
  endpoints: [
    {
      name: 'worker',
      session: 'acct',
      scope: { chats: [], folders: [...folders] },
      verbs: ['read', 'send'],
      tokenHash: hashEndpointToken(token),
    },
  ],
});

describe.skipIf(process.platform === 'win32')('a folder is a live scope unit', () => {
  guardProcessResources();
  let world: E2EWorld;
  let fake: FakeTelegramClient;
  let open: Client[];

  beforeEach(async () => {
    open = [];
    fake = new FakeTelegramClient([INSIDE, JOINING, OUTSIDE]);
    fake.folder = { id: FOLDER_ID, title: FOLDER_TITLE, chats: [INSIDE] };
    world = await E2EWorld.create('tmcp-folder-');
  });
  afterEach(async () => {
    for (const client of open) await client.close().catch(() => undefined);
    await world.dispose();
    expect(world.exitCodes()).toEqual([0]);
  });

  const start = async (folders: readonly (number | string)[]): Promise<Client> => {
    await world.seal({ config: policy(folders), sessionRefs: ['acct'], pin: PIN });
    await world.startDaemon({
      clientFactory: () => fake as unknown as TelegramClient,
    });
    await world.unlock(PIN);
    return connect();
  };

  const connect = async (): Promise<Client> => {
    const client = new Client({ name: 'folder-test', version: '0.0.0' });
    open.push(client);
    await client.connect(new SocketClientTransport(world.address(), { v: 1, token }));
    return client;
  };

  const send = async (client: Client, chat: number): Promise<boolean> => {
    const result = await client.callTool({
      name: 'send_message',
      arguments: { peer: { kind: 'id', value: String(chat) }, text: 'hi' },
    });
    return result.isError !== true;
  };

  it.each([
    ['by id', FOLDER_ID],
    ['by title', FOLDER_TITLE],
  ])('reaches the folder members and nothing else, addressed %s', async (_label, ref) => {
    const client = await start([ref]);

    expect(await send(client, INSIDE)).toBe(true);
    expect(await send(client, OUTSIDE)).toBe(false);
    expect(fake.sent).toHaveLength(1);
  }, 30_000);

  it('picks up a chat that joined the folder when the binding is next built', async () => {
    const client = await start([FOLDER_ID]);
    expect(await send(client, JOINING)).toBe(false);

    // The operator adds the chat to the folder in Telegram; no config changed here.
    fake.folder = { id: FOLDER_ID, title: FOLDER_TITLE, chats: [INSIDE, JOINING] };
    const operator = await world.unlock(PIN);
    expect((await operator.applyPolicy(JSON.stringify(policy([FOLDER_ID])))).ok).toBe(true);

    expect(await send(client, JOINING)).toBe(true);
    expect(await send(client, INSIDE)).toBe(true);
  }, 30_000);

  it('drops a chat that left the folder, on the same unchanged config', async () => {
    const client = await start([FOLDER_ID]);
    expect(await send(client, INSIDE)).toBe(true);

    fake.folder = { id: FOLDER_ID, title: FOLDER_TITLE, chats: [JOINING] };
    const operator = await world.unlock(PIN);
    expect((await operator.applyPolicy(JSON.stringify(policy([FOLDER_ID])))).ok).toBe(true);

    expect(await send(client, INSIDE)).toBe(false);
    expect(await send(client, JOINING)).toBe(true);
  }, 30_000);

  it('grants nothing when the named folder does not exist on the account', async () => {
    const client = await start(['Nonexistent']);

    expect(await send(client, INSIDE)).toBe(false);
    expect(await send(client, OUTSIDE)).toBe(false);
    expect(fake.sent).toEqual([]);
  }, 30_000);
});
