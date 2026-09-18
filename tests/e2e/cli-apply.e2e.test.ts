// `apply` as a real process: a draft edit is inert until the CLI seals it, and once it does the
// new policy governs the connection that is already open — no reconnect, no menu change.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
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

const run = promisify(execFile);
const PIN = 'correct-horse-battery';
const SCOPED_ID = 100;
const CLI = join(process.cwd(), 'dist', 'presentation', 'cli', 'main.js');

const configWith = (verbs: readonly string[], token: string): unknown => ({
  version: 1,
  endpoints: [
    {
      name: 'worker',
      session: 'acct',
      scope: { chats: [String(SCOPED_ID)], folders: [] },
      verbs,
      tokenHash: hashEndpointToken(token),
    },
  ],
});

describe.skipIf(process.platform === 'win32')('cli apply end to end', () => {
  guardProcessResources();
  const token = mintEndpointToken();
  let world: E2EWorld;
  let fake: FakeTelegramClient;
  let mcp: Client | undefined;

  beforeEach(async () => {
    fake = new FakeTelegramClient(SCOPED_ID);
    world = await E2EWorld.create('tmcp-apply-');
    await world.seal({
      config: configWith(['read'], token),
      sessionRefs: ['acct'],
      pin: PIN,
    });
    await world.startDaemon({
      clientFactory: () => fake as unknown as TelegramClient,
    });
    await world.unlock(PIN);
  });
  afterEach(async () => {
    await mcp?.close().catch(() => undefined);
    mcp = undefined;
    await world.dispose();
    expect(world.exitCodes()).toEqual([0]);
  });

  const openMcp = async (): Promise<Client> => {
    const client = new Client({ name: 'apply-e2e', version: '0.0.0' });
    mcp = client;
    await client.connect(
      new SocketClientTransport(world.address(), { v: 1, token }),
    );
    return client;
  };

  const send = async (client: Client): Promise<boolean> => {
    const result = await client.callTool({
      name: 'send_message',
      arguments: { peer: { kind: 'id', value: String(SCOPED_ID) }, text: 'hi' },
    });
    return result.isError !== true;
  };

  it('a draft edit is inert until `apply` seals it, then it governs a live connection', async () => {
    const client = await openMcp();
    const before = (await client.listTools()).tools.length;
    expect(await send(client)).toBe(false);

    // The draft alone must change nothing: the runtime trusts only the sealed policy.
    await writeFile(world.configPath, JSON.stringify(configWith(['read', 'send'], token)));
    expect(await send(client)).toBe(false);

    const applied = await run(process.execPath, [CLI, 'apply'], {
      env: world.childEnv({ TELEGRAM_MCP_SESSION_PASSPHRASE: PIN }),
    });
    expect(`${applied.stdout}${applied.stderr}`).toMatch(/appl|polic/i);

    expect(await send(client)).toBe(true);
    expect(fake.sent.map((m) => m.text)).toEqual(['hi']);
    // The menu is discovery and never changes with policy.
    expect((await client.listTools()).tools.length).toBe(before);
  }, 60_000);

  it('apply refuses a wrong unlock secret and leaves the policy alone', async () => {
    const client = await openMcp();
    await writeFile(world.configPath, JSON.stringify(configWith(['read', 'send'], token)));

    await expect(
      run(process.execPath, [CLI, 'apply'], {
        env: world.childEnv({ TELEGRAM_MCP_SESSION_PASSPHRASE: 'wrong-pin-value' }),
      }),
    ).rejects.toMatchObject({ code: 1 });

    expect(await send(client)).toBe(false);
  }, 60_000);
});
