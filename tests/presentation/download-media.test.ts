/**
 * Downloading, through the daemon rather than the gateway alone: the operator never names the
 * destination — the server confines it — and the size ceiling is enforced against what Telegram
 * CLAIMS before a byte is fetched, then again against what actually arrives. The ceiling is
 * policy, so it moves with an apply and without a restart.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
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
const MESSAGE_ID = 77;
const token = mintEndpointToken();

const policy = (maxDownloadBytes?: number): unknown => ({
  version: 1,
  ...(maxDownloadBytes !== undefined ? { maxDownloadBytes } : {}),
  endpoints: [
    {
      name: 'worker',
      session: 'acct',
      scope: { chats: [String(SCOPED_ID)], folders: [] },
      verbs: ['read', 'read_media'],
      tokenHash: hashEndpointToken(token),
    },
  ],
});

describe.skipIf(process.platform === 'win32')('download_media through the daemon', () => {
  guardProcessResources();
  let world: E2EWorld;
  let fake: FakeTelegramClient;
  let open: Client[];

  beforeEach(async () => {
    open = [];
    fake = new FakeTelegramClient(SCOPED_ID);
    world = await E2EWorld.create('tmcp-download-');
  });
  afterEach(async () => {
    for (const client of open) await client.close().catch(() => undefined);
    await world.dispose();
    expect(world.exitCodes()).toEqual([0]);
  });

  const start = async (config: unknown): Promise<Client> => {
    await world.seal({ config, sessionRefs: ['acct'], pin: PIN });
    await world.startDaemon({
      clientFactory: () => fake as unknown as TelegramClient,
    });
    await world.unlock(PIN);
    const client = new Client({ name: 'download-test', version: '0.0.0' });
    open.push(client);
    await client.connect(new SocketClientTransport(world.address(), { v: 1, token }));
    return client;
  };

  const download = (client: Client): ReturnType<Client['callTool']> =>
    client.callTool({
      name: 'download_media',
      arguments: {
        peer: { kind: 'id', value: String(SCOPED_ID) },
        messageId: MESSAGE_ID,
      },
    });

  type ToolResult = Awaited<ReturnType<Client['callTool']>>;

  // The server names the file; the caller only learns where it landed.
  const pathOf = (result: ToolResult): string => {
    const structured = result.structuredContent as
      | { readonly file_path?: string }
      | undefined;
    const path = structured?.file_path;
    if (typeof path !== 'string') {
      throw new Error(`no file_path in ${JSON.stringify(result.structuredContent)}`);
    }
    return path;
  };

  const downloadsDir = (): string => join(world.mediaDir, 'downloads');

  it('writes the bytes to a server-chosen path inside the media root', async () => {
    const body = Buffer.from('the attachment body');
    fake.media = { declaredBytes: body.length, body };
    const client = await start(policy());

    const result = await download(client);

    expect(result.isError).not.toBe(true);
    const path = pathOf(result);
    // The operator asked for a message, not a location: the path is the server's.
    expect(relative(world.mediaDir, path).startsWith('..')).toBe(false);
    expect((await stat(path)).size).toBe(body.length);
    expect(await readFile(path, 'utf8')).toBe(body.toString('utf8'));
  }, 30_000);

  it('refuses a declared size over the ceiling without fetching anything', async () => {
    const body = Buffer.from('small in truth, enormous in the claim');
    fake.media = { declaredBytes: 10 * 1024 * 1024, body };
    const client = await start(policy(1024));

    const result = await download(client);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('SIZE_CAP_EXCEEDED');
  }, 30_000);

  it('stops a download whose declared size lied, mid-stream, leaving no file', async () => {
    const CHUNKS = 8;
    const CHUNK_BYTES = 512;
    const body = Buffer.alloc(CHUNKS * CHUNK_BYTES, 0x61);
    // The claim fits the ceiling; the stream does not.
    fake.media = { declaredBytes: 512, body, chunkBytes: CHUNK_BYTES };
    const client = await start(policy(1024));

    const result = await download(client);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('SIZE_CAP_EXCEEDED');
    /**
     * The point of the progress hook is that the transfer STOPS. Counting what was asked for
     * is the only way to tell an abort from "downloaded it all, then measured it": the ceiling
     * is 1024 bytes, so it must give up after the slice that crosses it.
     */
    expect(fake.downloadChunks).toBeLessThan(CHUNKS);
    expect(fake.downloadChunks).toBeLessThanOrEqual(3);
    // The directory was created for the attempt, but nothing — not even a partial — survives.
    expect(await readdir(downloadsDir())).toEqual([]);
  }, 30_000);

  it('takes a new ceiling from a policy apply, with no restart', async () => {
    const body = Buffer.from('x'.repeat(2048));
    fake.media = { declaredBytes: body.length, body };
    const client = await start(policy(1024));
    expect((await download(client)).isError).toBe(true);

    const operator = await world.unlock(PIN);
    expect((await operator.applyPolicy(JSON.stringify(policy(1024 * 1024)))).ok).toBe(true);

    const result = await download(client);
    expect(result.isError).not.toBe(true);
    expect((await stat(pathOf(result))).size).toBe(body.length);
  }, 30_000);
});
