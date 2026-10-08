// `apply` as a real process: a draft edit is inert until the CLI seals it, and once it does the
// new policy governs the connection that is already open — no reconnect, no menu change.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
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

const OTHER_ID = 200;

interface PolicyShape {
  readonly verbs?: readonly string[];
  readonly chats?: readonly number[];
  readonly disabledVerbs?: readonly string[];
}

const configWith = (token: string, shape: PolicyShape = {}): unknown => ({
  version: 1,
  killSwitch: { disabledVerbs: shape.disabledVerbs ?? [] },
  endpoints: [
    {
      name: 'worker',
      session: 'acct',
      scope: {
        chats: (shape.chats ?? [SCOPED_ID]).map((id) => String(id)),
        folders: [],
      },
      verbs: shape.verbs ?? ['read'],
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

  let factoryCalls: number;

  const startDaemon = async (): Promise<void> => {
    await world.startDaemon({
      clientFactory: () => {
        factoryCalls += 1;
        return fake as unknown as TelegramClient;
      },
    });
    await world.unlock(PIN);
  };

  beforeEach(async () => {
    factoryCalls = 0;
    fake = new FakeTelegramClient([SCOPED_ID, OTHER_ID]);
    world = await E2EWorld.create('tmcp-apply-');
    await world.seal({
      config: configWith(token),
      sessionRefs: ['acct'],
      pin: PIN,
    });
    await startDaemon();
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

  const call = (
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): ReturnType<Client['callTool']> => client.callTool({ name, arguments: args });

  const send = async (client: Client, peer = SCOPED_ID): Promise<boolean> => {
    const result = await call(client, 'send_message', {
      peer: { kind: 'id', value: String(peer) },
      text: 'hi',
    });
    return result.isError !== true;
  };

  // The refusal payload, so a case can name the reason instead of settling for `isError`.
  const refusal = async (client: Client, peer = SCOPED_ID): Promise<string> => {
    const result = await call(client, 'send_message', {
      peer: { kind: 'id', value: String(peer) },
      text: 'hi',
    });
    expect(result.isError, 'the call was expected to be refused').toBe(true);
    return JSON.stringify(result.content);
  };

  const apply = (secret = PIN): Promise<{ readonly stdout: string }> =>
    run(process.execPath, [CLI, 'apply'], {
      env: world.childEnv({ TELEGRAM_MCP_SESSION_PASSPHRASE: secret }),
    });

  const writeDraft = (config: unknown): Promise<void> =>
    writeFile(world.configPath, JSON.stringify(config));

  // The sealed policy as it sits on disk — the only thing a restart will trust.
  const sealedPolicy = (): Promise<Buffer> =>
    readFile(join(world.sessionDir, 'policy.blob'));

  it('a draft edit is inert until `apply` seals it, then it governs a live connection', async () => {
    const client = await openMcp();
    const before = (await client.listTools()).tools.length;
    expect(await send(client)).toBe(false);

    // The draft alone must change nothing: the runtime trusts only the sealed policy.
    await writeDraft(configWith(token, { verbs: ['read', 'send'] }));
    expect(await send(client)).toBe(false);

    await apply();

    expect(await send(client)).toBe(true);
    expect(fake.sent.map((m) => m.text)).toEqual(['hi']);
    // The menu is discovery and never changes with policy.
    expect((await client.listTools()).tools.length).toBe(before);
  }, 60_000);

  it('apply refuses a wrong unlock secret and leaves the policy alone', async () => {
    const client = await openMcp();
    await writeDraft(configWith(token, { verbs: ['read', 'send'] }));

    await expect(apply('wrong-pin-value')).rejects.toMatchObject({ code: 1 });

    expect(await send(client)).toBe(false);
  }, 60_000);

  /**
   * Narrowing is the direction that matters: a policy that only ever widens cannot take a
   * capability back. Each case starts from a write that REALLY happened, so an
   * infrastructure-level failure cannot be mistaken for an ACL decision.
   */
  describe('a narrowed policy takes effect on the open connection', () => {
    const grantWrite = async (client: Client): Promise<void> => {
      await writeDraft(configWith(token, { verbs: ['read', 'send'] }));
      await apply();
      expect(await send(client)).toBe(true);
      expect(fake.sent).toHaveLength(1);
    };

    it('withdrawing the verb refuses the next write and spends no Telegram call', async () => {
      const client = await openMcp();
      await grantWrite(client);

      await writeDraft(configWith(token, { verbs: ['read'] }));
      await apply();

      expect(await refusal(client)).toContain('ACL_DENIED');
      expect(fake.sent).toHaveLength(1);
      // The endpoint keeps working for what it may still do.
      expect((await call(client, 'list_dialogs', {})).isError).not.toBe(true);
      // Rebinding the scope must not redial Telegram.
      expect(factoryCalls).toBe(1);
    }, 60_000);

    it('withdrawing the chat refuses that chat while the endpoint keeps its verb', async () => {
      const client = await openMcp();
      await writeDraft(configWith(token, {
        verbs: ['read', 'send'],
        chats: [SCOPED_ID, OTHER_ID],
      }));
      await apply();
      expect(await send(client, OTHER_ID)).toBe(true);

      await writeDraft(configWith(token, { verbs: ['read', 'send'], chats: [SCOPED_ID] }));
      await apply();

      expect(await refusal(client, OTHER_ID)).toContain('ACL_DENIED');
      expect(await send(client, SCOPED_ID)).toBe(true);
      expect(fake.sent.map((m) => m.text)).toEqual(['hi', 'hi']);
    }, 60_000);

    it('the kill switch disables the verb everywhere, leaving reads alone', async () => {
      const client = await openMcp();
      await grantWrite(client);

      await writeDraft(configWith(token, {
        verbs: ['read', 'send'],
        disabledVerbs: ['send'],
      }));
      await apply();

      expect(await refusal(client)).toContain('ACL_DENIED');
      expect(fake.sent).toHaveLength(1);
      expect((await call(client, 'list_dialogs', {})).isError).not.toBe(true);
    }, 60_000);
  });

  /**
   * A restart is the only honest test of persistence: until then a passing call may be served
   * by a live cache rather than by anything that reached the disk.
   */
  it('after a restart the last SEALED policy governs, and an unapplied draft still does not', async () => {
    const first = await openMcp();
    await writeDraft(configWith(token, { verbs: ['read', 'send'] }));
    await apply();
    expect(await send(first)).toBe(true);
    await first.close();
    mcp = undefined;

    // Left on disk unapplied: it would grant a second chat if the draft were ever trusted.
    await writeDraft(configWith(token, {
      verbs: ['read', 'send'],
      chats: [SCOPED_ID, OTHER_ID],
    }));

    await world.stopDaemon();
    await startDaemon();
    const second = await openMcp();

    expect(await send(second, SCOPED_ID)).toBe(true);
    expect(await refusal(second, OTHER_ID)).toContain('ACL_DENIED');
  }, 60_000);

  /**
   * These drafts are refused BEFORE anything is sealed, so the previous rights must still be
   * exercisable — and a corrected draft must still go through, or the CLI would be one bad
   * edit away from a dead installation.
   */
  describe('a draft that cannot be sealed changes nothing', () => {
    const BAD_DRAFTS: readonly (readonly [string, string])[] = [
      ['malformed JSON', '{"version": 1, "endpoints": ['],
      ['a schema violation', JSON.stringify({ version: 1, endpoints: [{ name: 'worker' }] })],
      ['an unknown verb', '{"version":1,"endpoints":[{"name":"worker","session":"acct","scope":{"chats":["100"],"folders":[]},"verbs":["read","fly"],"tokenHash":"TOKEN_HASH"}]}'],
    ];

    const badDraft = (body: string): string =>
      body.replace('TOKEN_HASH', hashEndpointToken(token));

    it.each(BAD_DRAFTS)(
      'rejects %s, leaves the sealed bytes untouched, and stays repairable',
      async (_label, body) => {
        const client = await openMcp();
        await writeDraft(configWith(token, { verbs: ['read', 'send'] }));
        await apply();
        expect(await send(client)).toBe(true);
        const before = await sealedPolicy();

        await writeFile(world.configPath, badDraft(body));
        await expect(apply()).rejects.toMatchObject({ code: 1 });

        /**
         * Not just "the live call still works": a seal written before validation would leave
         * the running daemon serving a cached policy while the bytes on disk are already
         * broken, and the next successful apply would repair them before anyone looked.
         */
        expect(await sealedPolicy()).toEqual(before);
        expect(await send(client)).toBe(true);
        expect(fake.sent).toHaveLength(2);

        // And the operator can still get out of it.
        await writeDraft(configWith(token, { verbs: ['read'] }));
        await apply();
        expect(await refusal(client)).toContain('ACL_DENIED');
      },
      60_000,
    );

    it('survives a restart before the draft is repaired', async () => {
      const first = await openMcp();
      await writeDraft(configWith(token, { verbs: ['read', 'send'] }));
      await apply();
      expect(await send(first)).toBe(true);
      await first.close();
      mcp = undefined;

      await writeFile(world.configPath, '{"version": 1, "endpoints": [');
      await expect(apply()).rejects.toMatchObject({ code: 1 });

      // The daemon that comes up next reads the blob, not the cache and not the broken draft.
      await world.stopDaemon();
      await startDaemon();

      const second = await openMcp();
      expect(await send(second)).toBe(true);
      expect(fake.sent).toHaveLength(2);
    }, 60_000);
  });
});
