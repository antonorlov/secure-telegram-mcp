// The gap this suite closes: a tool call through the real `connect` shim process, over the unix
// socket, into the daemon. Only the Telegram transport is faked; the shim, the handshake, the
// JSON-RPC piping and the daemon are real.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import type { TelegramClient } from 'telegram';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import {
  hashEndpointToken,
  mintEndpointToken,
} from '../../src/infrastructure/endpoint-token.js';
import { FakeTelegramClient } from '../_support/fake-telegram-client.js';
import { API_HASH, E2EWorld, SESSION_STRING } from '../_support/e2e-world.js';
import { guardProcessResources } from '../_support/resource-guards.js';

const PIN = 'correct-horse-battery';
const SCOPED_ID = 100;
const CLI = join(process.cwd(), 'dist', 'presentation', 'cli', 'main.js');

describe.skipIf(process.platform === 'win32')('connect shim end to end', () => {
  guardProcessResources();

  const token = mintEndpointToken();
  let world: E2EWorld;
  let fake: FakeTelegramClient;
  let shim: Client | undefined;
  let stderr = '';
  // Every JSON-RPC message the shim sends back, captured before the SDK parses it.
  let protocol: string[] = [];

  beforeEach(async () => {
    stderr = '';
    protocol = [];
    fake = new FakeTelegramClient(SCOPED_ID);
    world = await E2EWorld.create('tmcp-shim-');
    await world.seal({
      config: {
        version: 1,
        endpoints: [
          {
            name: 'worker',
            session: 'acct',
            scope: { chats: [String(SCOPED_ID)], folders: [] },
            verbs: ['read', 'send'],
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

  // Spawns the published entrypoint; the daemon is already up, so the shim attaches to it.
  const connectShim = async (): Promise<Client> => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'connect'],
      env: world.childEnv({ TELEGRAM_MCP_ENDPOINT_TOKEN: token }),
      stderr: 'pipe',
    });
    /**
     * Tap the incoming lane BEFORE connecting: `initialize` answers first, and its
     * `instructions` are a surface the model reads. `Protocol.connect` keeps an already-set
     * `onmessage` and calls it ahead of its own, so this sees every message.
     */
    transport.onmessage = (message: JSONRPCMessage): void => {
      protocol.push(JSON.stringify(message));
    };
    const client = new Client({ name: 'shim-e2e', version: '0.0.0' });
    shim = client;
    await client.connect(transport);
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    return client;
  };

  it('serves the static menu through the shim', async () => {
    const client = await connectShim();
    const names = (await client.listTools()).tools.map((t) => t.name);

    expect(names).toContain('list_dialogs');
    expect(names).toContain('send_message');
    expect(names).not.toContain('invoke');
  }, 30_000);

  it('a read reaches the scoped client and comes back through the shim', async () => {
    const client = await connectShim();

    const result = await client.callTool({
      name: 'list_dialogs',
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain(String(SCOPED_ID));
    expect(fake.connectCalls).toBe(1);
  }, 30_000);

  it('a write reaches Telegram and the ack returns through the shim', async () => {
    const client = await connectShim();

    const result = await client.callTool({
      name: 'send_message',
      arguments: { peer: { kind: 'id', value: String(SCOPED_ID) }, text: 'hello' },
    });

    expect(result.isError).not.toBe(true);
    expect(fake.sent.map((m) => m.text)).toEqual(['hello']);
  }, 30_000);

  it('an out-of-scope write is refused and never reaches Telegram', async () => {
    const client = await connectShim();

    const result = await client.callTool({
      name: 'send_message',
      arguments: { peer: { kind: 'id', value: '999' }, text: 'nope' },
    });

    expect(result.isError).toBe(true);
    expect(fake.sent).toEqual([]);
  }, 30_000);

  it('no secret reaches the protocol, the shim transcript, the daemon log or the fixture tree', async () => {
    const client = await connectShim();
    const read = await client.callTool({ name: 'list_dialogs', arguments: {} });
    const write = await client.callTool({
      name: 'send_message',
      arguments: { peer: { kind: 'id', value: String(SCOPED_ID) }, text: 'hello' },
    });
    // A shim that answered nothing would also leak nothing: both calls must have succeeded.
    expect(read.isError).not.toBe(true);
    expect(write.isError).not.toBe(true);
    expect(JSON.stringify(read.structuredContent)).toContain(String(SCOPED_ID));

    const secrets = [
      { label: 'the endpoint key', value: token },
      { label: 'the PIN', value: PIN },
      { label: 'the session string', value: SESSION_STRING },
      { label: 'the api_hash', value: API_HASH },
    ];
    const surfaces = {
      "the shim's stderr": stderr,
      'the protocol transcript': protocol.join('\n'),
    };
    const inspected = await world.assertNoLeaks(secrets, surfaces);
    // config.json carries only the salted hash, and the blobs are sealed.
    expect(inspected).toBeGreaterThan(2);
    // The transcript must START at initialization — the response carrying the server's name
    // and instructions — or everything before the first tool call would go unscanned.
    expect(protocol.length).toBeGreaterThanOrEqual(3);
    expect(protocol[0]).toContain('"protocolVersion"');
    expect(protocol[0]).toContain('"serverInfo"');
    expect(protocol.join('\n')).toContain(String(SCOPED_ID));

    // Negative control: the same sweep with a deliberately leaking surface must fail, or the
    // assertion above would be vacuous.
    await expect(
      world.assertNoLeaks(secrets, {
        ...surfaces,
        'a planted control surface': `prefix ${SESSION_STRING} suffix`,
      }),
    ).rejects.toThrow('the session string leaked');
  }, 30_000);
});
