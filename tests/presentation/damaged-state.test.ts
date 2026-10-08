/**
 * What a daemon does when the state it is supposed to trust is damaged. The draft on disk is
 * always the more tempting document — it is plain JSON, it parses, and in these cases it grants
 * MORE than the sealed policy did. None of that may make it executable, and a store that is
 * merely broken must not read as a clean first install.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
const token = mintEndpointToken();

const policy = (verbs: readonly string[]): unknown => ({
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

describe.skipIf(process.platform === 'win32')('a damaged store never promotes the draft', () => {
  guardProcessResources();
  let world: E2EWorld;
  let fake: FakeTelegramClient;
  let open: Client[];
  // A daemon that refused to boot reports no exit code, and that is a pass, not a leak.
  let started: boolean;

  beforeEach(async () => {
    open = [];
    started = false;
    fake = new FakeTelegramClient(SCOPED_ID);
    world = await E2EWorld.create('tmcp-damaged-');
    // Sealed read-only, with a draft on disk that would grant writing if it were ever trusted.
    await world.seal({ config: policy(['read']), sessionRefs: ['acct'], pin: PIN });
    await writeFile(world.configPath, JSON.stringify(policy(['read', 'send'])));
  });
  afterEach(async () => {
    for (const client of open) await client.close().catch(() => undefined);
    await world.dispose();
    expect(world.exitCodes()).toEqual(started ? [0] : []);
  });

  const connect = async (): Promise<Client> => {
    const client = new Client({ name: 'damaged-test', version: '0.0.0' });
    open.push(client);
    await client.connect(new SocketClientTransport(world.address(), { v: 1, token }));
    return client;
  };

  // The endpoint's OWN verb. A refusal here cannot be the ACL talking — which is the whole
  // point when the thing under test is the state behind it.
  const read = (client: Client): ReturnType<Client['callTool']> =>
    client.callTool({ name: 'list_dialogs', arguments: {} });

  const startWithFake = async (): Promise<void> => {
    await world.startDaemon({
      clientFactory: () => fake as unknown as TelegramClient,
    });
    started = true;
  };

  it('refuses to come up at all when the sealed policy is corrupt', async () => {
    await writeFile(join(world.sessionDir, 'policy.blob'), 'not an envelope');

    /**
     * Not "serve the draft", not "assume no PIN": the posture is derived from the blob's slots,
     * and a blob that cannot be read leaves that question unanswerable. The daemon stops
     * instead of guessing, and says what is wrong without quoting any of it.
     */
    const failure = await startWithFake().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/posture|corrupt/i);
    expect(message).not.toContain(PIN);
    expect(message).not.toContain(token);
    expect(fake.sent).toEqual([]);
  }, 30_000);

  it('gives the draft no authority when the sealed policy is missing', async () => {
    await rm(join(world.sessionDir, 'policy.blob'), { force: true });
    await startWithFake();

    /**
     * The daemon does come up — an operator has to be able to recover from here — but the key
     * in the plain draft opens nothing: without a seal there is no enforced menu to match it
     * against, so the connection is refused outright.
     */
    await expect(connect()).rejects.toThrow();
    // Nothing was opened towards Telegram either.
    expect(fake.connectCalls).toBe(0);
    expect(fake.sent).toEqual([]);
  }, 30_000);

  it('fails closed, and secret-free, when the session file itself is corrupt', async () => {
    // The store keeps one `<ref>.session` per account; `policy.blob` is the other file.
    const sessionFile = join(world.sessionDir, 'acct.session');
    expect(existsSync(sessionFile), 'the session file is not where the test thinks').toBe(
      true,
    );
    await writeFile(sessionFile, 'not an envelope');
    await startWithFake();
    await world.unlock(PIN);

    const client = await connect();
    // A READ, which this endpoint is allowed: the only thing that can refuse it is the
    // unreadable session behind it.
    const result = await read(client);

    expect(result.isError).toBe(true);
    const payload = JSON.stringify(result.content);
    expect(payload).not.toContain(PIN);
    expect(payload).not.toContain(token);
    // Nothing reached Telegram: the account could never be opened.
    expect(fake.connectCalls).toBe(0);
  }, 30_000);
});
