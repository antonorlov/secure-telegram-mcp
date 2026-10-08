/**
 * The two write branches an ordinary `send_message` does not represent: a forward, which is
 * authorized on BOTH sides, and the two-phase media send, where the decision and the upload are
 * separated in time. Both run through the daemon, because that separation is exactly where a
 * check can go missing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TelegramClient } from 'telegram';
import type { OperatorClient } from '../../src/presentation/operator/client.js';
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
const SOURCE = 100;
const DESTINATION = 200;
const OUTSIDE = 300;

const token = mintEndpointToken();

const policy = (
  verbs: readonly string[],
  chats: readonly number[],
  chatOverrides: Readonly<Record<string, readonly string[]>> = {},
): unknown => ({
  version: 1,
  endpoints: [
    {
      name: 'worker',
      session: 'acct',
      scope: { chats: chats.map((id) => String(id)), folders: [], chatOverrides },
      verbs,
      tokenHash: hashEndpointToken(token),
    },
  ],
});

describe.skipIf(process.platform === 'win32')('forwarding and two-phase media', () => {
  guardProcessResources();
  let world: E2EWorld;
  let fake: FakeTelegramClient;
  let open: Client[];

  const start = async (config: unknown): Promise<Client> => {
    await world.seal({ config, sessionRefs: ['acct'], pin: PIN });
    await world.startDaemon({
      clientFactory: () => fake as unknown as TelegramClient,
    });
    await world.unlock(PIN);
    const client = new Client({ name: 'branches-test', version: '0.0.0' });
    open.push(client);
    await client.connect(new SocketClientTransport(world.address(), { v: 1, token }));
    return client;
  };

  beforeEach(async () => {
    open = [];
    // Every chat the cases mention exists on the account; scope decides what may be touched.
    fake = new FakeTelegramClient([SOURCE, DESTINATION, OUTSIDE]);
    world = await E2EWorld.create('tmcp-branches-');
  });
  afterEach(async () => {
    for (const client of open) await client.close().catch(() => undefined);
    await world.dispose();
    expect(world.exitCodes()).toEqual([0]);
  });

  // The sealed policy as it sits on disk — what the daemon writes before it retires bindings.
  const sealedPolicy = (): Promise<Buffer> =>
    readFile(join(world.sessionDir, 'policy.blob'));

  const forward = (
    client: Client,
    from: number,
    to: number,
  ): ReturnType<Client['callTool']> =>
    client.callTool({
      name: 'forward_message',
      arguments: {
        fromPeer: { kind: 'id', value: String(from) },
        toPeer: { kind: 'id', value: String(to) },
        messageIds: [7],
      },
    });

  describe('forward_message is authorized on both sides', () => {
    it('forwards when the source may be read and the destination may be written', async () => {
      const client = await start(policy(['read', 'forward'], [SOURCE, DESTINATION]));

      const result = await forward(client, SOURCE, DESTINATION);

      expect(result.isError).not.toBe(true);
      expect(fake.forwarded).toHaveLength(1);
      expect(fake.forwarded[0]?.messageIds).toEqual([7]);
      // The ids Telegram returned for the DESTINATION copies, not the source ids.
      expect(JSON.stringify(result.structuredContent)).toContain('1007');
    }, 20_000);

    it('refuses when the source is out of scope, and forwards nothing', async () => {
      const client = await start(policy(['read', 'forward'], [DESTINATION]));

      const result = await forward(client, OUTSIDE, DESTINATION);

      expect(result.isError).toBe(true);
      expect(fake.forwarded).toEqual([]);
    }, 20_000);

    it('refuses when the destination is out of scope, and forwards nothing', async () => {
      const client = await start(policy(['read', 'forward'], [SOURCE]));

      const result = await forward(client, SOURCE, OUTSIDE);

      expect(result.isError).toBe(true);
      expect(fake.forwarded).toEqual([]);
    }, 20_000);

    /**
     * The sharpest version of "both sides": the destination IS in scope and IS readable, and
     * only the forward verb is withheld on it. Nothing but the destination-side verb check can
     * refuse this one.
     */
    it('refuses a destination the endpoint may read but not forward into', async () => {
      const client = await start(
        policy(['read', 'forward'], [SOURCE, DESTINATION], {
          [String(DESTINATION)]: ['read'],
        }),
      );

      const result = await forward(client, SOURCE, DESTINATION);

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('ACL_DENIED');
      expect(fake.forwarded).toEqual([]);
    }, 20_000);

    it('refuses when the endpoint may read both chats but not forward', async () => {
      const client = await start(policy(['read'], [SOURCE, DESTINATION]));

      const result = await forward(client, SOURCE, DESTINATION);

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('ACL_DENIED');
      expect(fake.forwarded).toEqual([]);
    }, 20_000);
  });

  /**
   * `SECURITY.md` is explicit that an operation already admitted may finish after a policy
   * apply; the prohibition binds the NEXT call. Asserting the tidier "everything in flight is
   * killed" would be a feature request, and the wrong oracle here would hide a real regression:
   * a policy that never took effect at all.
   */
  it('lets an admitted send finish after a narrowing apply, and refuses the next one', async () => {
    const client = await start(policy(['read', 'send'], [SOURCE]));
    let release = (): void => undefined;
    fake.holdSends = new Promise<void>((resolve) => {
      release = resolve;
    });

    const inFlight = client.callTool({
      name: 'send_message',
      arguments: { peer: { kind: 'id', value: String(SOURCE) }, text: 'admitted' },
    });
    let applying: ReturnType<OperatorClient['applyPolicy']> | undefined;
    try {
      // Wait for the call to be INSIDE Telegram, not merely issued.
      for (let i = 0; i < 200 && fake.sendAttempts === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(fake.sendAttempts).toBe(1);

      const operator = await world.unlock(PIN);
      const sealedBefore = await sealedPolicy();
      applying = operator.applyPolicy(JSON.stringify(policy(['read'], [SOURCE])));

      /**
       * Wait for the new policy to be SEALED, which the daemon does before it retires the old
       * bindings. From here the two really overlap: the seal on disk is already the narrow one
       * while the admitted send is still inside Telegram.
       */
      for (let i = 0; i < 300; i += 1) {
        if (!(await sealedPolicy()).equals(sealedBefore)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await sealedPolicy()).equals(sealedBefore)).toBe(false);

      // And the apply must NOT report success while an operation it admitted is still running:
      // retiring the old bindings drains them first.
      const early = await Promise.race([
        applying.then(() => 'settled'),
        new Promise<string>((resolve) => setTimeout(() => {
          resolve('still draining');
        }, 300)),
      ]);
      expect(early, 'apply finished without draining the operation it admitted').toBe(
        'still draining',
      );
    } finally {
      /**
       * Unconditionally, even when an assertion above failed: a held send would otherwise
       * outlive the case, hang the daemon's own teardown and surface as an unhandled rejection
       * from a promise nobody is left to await.
       */
      release();
      await Promise.allSettled([inFlight, applying ?? Promise.resolve()]);
    }

    // Reachable only when the try completed, so the apply did start.
    expect((await applying).ok).toBe(true);
    expect((await inFlight).isError).not.toBe(true);
    expect(fake.sent.map((m) => m.text)).toEqual(['admitted']);

    // The next call is where the new policy binds.
    const next = await client.callTool({
      name: 'send_message',
      arguments: { peer: { kind: 'id', value: String(SOURCE) }, text: 'too late' },
    });
    expect(next.isError).toBe(true);
    expect(JSON.stringify(next.content)).toContain('ACL_DENIED');
    expect(fake.sent.map((m) => m.text)).toEqual(['admitted']);
  }, 30_000);

  describe('a media handle is a one-time decision, re-checked at upload', () => {
    const stage = async (name: string, bytes: string): Promise<string> => {
      await mkdir(world.mediaDir, { recursive: true });
      const path = join(world.mediaDir, name);
      await writeFile(path, bytes, 'utf8');
      return path;
    };

    const prepare = async (client: Client, localPath: string): Promise<string> => {
      const prepared = await client.callTool({
        name: 'prepare_media',
        arguments: { localPath },
      });
      expect(prepared.isError).not.toBe(true);
      return (prepared.structuredContent as { readonly handle: string }).handle;
    };

    const sendMedia = (
      client: Client,
      handle: string,
      peer = SOURCE,
    ): ReturnType<Client['callTool']> =>
      client.callTool({
        name: 'send_media',
        arguments: { peer: { kind: 'id', value: String(peer) }, handle, caption: 'here' },
      });

    it('uploads once and refuses the same handle a second time', async () => {
      const client = await start(policy(['read', 'send'], [SOURCE]));
      const handle = await prepare(client, await stage('report.txt', 'payload'));

      expect((await sendMedia(client, handle)).isError).not.toBe(true);
      const replay = await sendMedia(client, handle);

      expect(replay.isError).toBe(true);
      expect(JSON.stringify(replay.content)).toContain('INVALID_MEDIA_HANDLE');
      expect(fake.sent.map((m) => m.text)).toEqual(['here']);
    }, 20_000);

    it('re-checks the file at upload: one swapped past the cap is refused', async () => {
      const client = await start(policy(['read', 'send'], [SOURCE]));
      const path = await stage('swap.txt', 'small');
      const handle = await prepare(client, path);

      // Same path, same name, contents replaced between the decision and the upload.
      await writeFile(path, 'x'.repeat(51 * 1024 * 1024), 'utf8');
      const result = await sendMedia(client, handle);

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('SIZE_CAP_EXCEEDED');
      expect(fake.sent).toEqual([]);
    }, 30_000);

    it('obeys a policy that withdrew the write after the handle was minted', async () => {
      const client = await start(policy(['read', 'send'], [SOURCE]));
      const handle = await prepare(client, await stage('late.txt', 'payload'));
      const operator = await world.unlock(PIN);

      expect(
        (await operator.applyPolicy(JSON.stringify(policy(['read'], [SOURCE])))).ok,
      ).toBe(true);
      const result = await sendMedia(client, handle);

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('ACL_DENIED');
      expect(fake.sent).toEqual([]);
    }, 20_000);
  });
});
