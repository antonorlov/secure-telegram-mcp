/**
 * Reading a long history through the real `connect` process. The parts that only appear once
 * the whole chain is assembled: a cursor that actually continues where the last page stopped,
 * a page that stops offering one when the history ends, and a response too large for the
 * output cap that says so instead of quietly losing rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import type { TelegramClient } from 'telegram';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  hashEndpointToken,
  mintEndpointToken,
} from '../../src/infrastructure/endpoint-token.js';
import { FakeTelegramClient } from '../_support/fake-telegram-client.js';
import { E2EWorld } from '../_support/e2e-world.js';
import { guardProcessResources } from '../_support/resource-guards.js';

const PIN = 'correct-horse-battery';
const SCOPED_ID = 100;
const CLI = join(process.cwd(), 'dist', 'presentation', 'cli', 'main.js');
const token = mintEndpointToken();

interface Page {
  // Untrusted text travels under its own key; the body is 'untrusted_text'.
  readonly messages?: readonly { readonly untrusted_text?: string; readonly message_id?: number }[];
  readonly next_cursor?: string;
  readonly truncated?: boolean;
}

describe.skipIf(process.platform === 'win32')('paged reads through the shim', () => {
  guardProcessResources();
  let world: E2EWorld;
  let fake: FakeTelegramClient;
  let shim: Client | undefined;

  beforeEach(async () => {
    fake = new FakeTelegramClient(SCOPED_ID);
    world = await E2EWorld.create('tmcp-paging-');
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
    });
    await world.unlock(PIN);
  });
  afterEach(async () => {
    await shim?.close().catch(() => undefined);
    shim = undefined;
    await world.dispose();
    expect(world.exitCodes()).toEqual([0]);
  });

  const connectShim = async (): Promise<Client> => {
    const client = new Client({ name: 'paging-e2e', version: '0.0.0' });
    shim = client;
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, 'connect'],
        env: world.childEnv({ TELEGRAM_MCP_ENDPOINT_TOKEN: token }),
        stderr: 'ignore',
      }),
    );
    return client;
  };

  const page = async (
    client: Client,
    limit: number,
    cursor?: string,
  ): Promise<Page> => {
    const result = await client.callTool({
      name: 'get_messages',
      arguments: {
        peer: { kind: 'id', value: String(SCOPED_ID) },
        limit,
        ...(cursor !== undefined ? { cursor } : {}),
      },
    });
    expect(result.isError).not.toBe(true);
    return result.structuredContent as Page;
  };

  it('walks a history in pages that continue where the last one stopped', async () => {
    fake.seedHistory(25, (id) => `message ${String(id)}`);
    const client = await connectShim();

    const first = await page(client, 10);
    expect(first.messages).toHaveLength(10);
    expect(first.next_cursor).toBeDefined();
    const firstTexts = (first.messages ?? []).map((item) => item.untrusted_text);
    expect(firstTexts[0]).toBe('message 25');

    const second = await page(client, 10, first.next_cursor);
    const secondTexts = (second.messages ?? []).map((item) => item.untrusted_text);

    expect(secondTexts).toHaveLength(10);
    // Continuation, not repetition: the second page starts below the first one's last row.
    expect(secondTexts[0]).toBe('message 15');
    expect(new Set([...firstTexts, ...secondTexts]).size).toBe(20);
  }, 60_000);

  it('stops offering a cursor once the history runs out', async () => {
    fake.seedHistory(12, (id) => `message ${String(id)}`);
    const client = await connectShim();

    const first = await page(client, 10);
    const last = await page(client, 10, first.next_cursor);

    expect(last.messages).toHaveLength(2);
    // A short page is the end of the road, and the caller is told so by omission.
    expect(last.next_cursor).toBeUndefined();
  }, 60_000);

  it('marks a response the output cap had to cut instead of silently dropping rows', async () => {
    // Each row is large enough that a full page cannot fit the cap.
    fake.seedHistory(50, () => 'x'.repeat(40_000));
    const client = await connectShim();

    const result = await page(client, 50);

    expect(result.truncated).toBe(true);
    expect((result.messages ?? []).length).toBeLessThan(50);
    expect((result.messages ?? []).length).toBeGreaterThan(0);
  }, 60_000);
});
