/**
 * Which secret the CLI actually unlocks with. The resolver is private to `main.ts`, so the only
 * honest way to pin its precedence is to hand the real `apply` process an environment and see
 * whether the policy moved. The rule that matters is fail-closed: the FIRST channel present
 * wins even when it is wrong — there is no quiet fallback to a correct lower-priority one,
 * which would let a stale variable silently outrank the operator's intent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { TelegramClient } from 'telegram';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  hashEndpointToken,
  mintEndpointToken,
} from '../../src/infrastructure/endpoint-token.js';
import { MAX_PASSPHRASE_FILE_BYTES } from '../../src/infrastructure/bounded-read.js';
import { SocketClientTransport } from '../_support/socket-mcp-client.js';
import { FakeTelegramClient } from '../_support/fake-telegram-client.js';
import { E2EWorld } from '../_support/e2e-world.js';
import { guardProcessResources } from '../_support/resource-guards.js';

const run = promisify(execFile);
const PIN = 'correct-horse-battery';
const WRONG = 'not-the-pin-at-all';
const SCOPED_ID = 100;
const CLI = join(process.cwd(), 'dist', 'presentation', 'cli', 'main.js');

const PASS_FILE = 'TELEGRAM_MCP_SESSION_PASSPHRASE_FILE';
const PASS = 'TELEGRAM_MCP_SESSION_PASSPHRASE';
const KEYFILE = 'TELEGRAM_MCP_SESSION_KEYFILE';

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

describe.skipIf(process.platform === 'win32')('cli unlock channels', () => {
  guardProcessResources();
  const token = mintEndpointToken();
  let world: E2EWorld;
  let fake: FakeTelegramClient;
  let mcp: Client | undefined;

  beforeEach(async () => {
    fake = new FakeTelegramClient(SCOPED_ID);
    world = await E2EWorld.create('tmcp-unlock-');
    await world.seal({
      config: configWith(['read'], token),
      sessionRefs: ['acct'],
      pin: PIN,
    });
    await world.startDaemon({
      clientFactory: () => fake as unknown as TelegramClient,
    });
    await world.unlock(PIN);
    // Every case applies the SAME widening, so only the unlock channel decides the outcome.
    await writeFile(world.configPath, JSON.stringify(configWith(['read', 'send'], token)));
  });
  afterEach(async () => {
    await mcp?.close().catch(() => undefined);
    mcp = undefined;
    await world.dispose();
    expect(world.exitCodes()).toEqual([0]);
  });

  // True once the widened policy is live — the observable proof that the unlock was accepted.
  const applied = async (): Promise<boolean> => {
    const client = new Client({ name: 'unlock-e2e', version: '0.0.0' });
    mcp = client;
    await client.connect(new SocketClientTransport(world.address(), { v: 1, token }));
    const result = await client.callTool({
      name: 'send_message',
      arguments: { peer: { kind: 'id', value: String(SCOPED_ID) }, text: 'hi' },
    });
    await client.close();
    mcp = undefined;
    return result.isError !== true;
  };

  const apply = (
    env: Readonly<Record<string, string>>,
  ): Promise<{ readonly stdout: string; readonly stderr: string }> =>
    run(process.execPath, [CLI, 'apply'], { env: world.childEnv(env) });

  /**
   * The diagnostic the CLI printed. A refused PIN also exits 1, so without reading the reason a
   * case cannot tell "the channel was rejected" from "the channel was read and the secret was
   * wrong" — which is how a removed size cap or an ignored empty variable slips through.
   */
  const applyFails = async (
    env: Readonly<Record<string, string>>,
  ): Promise<string> => {
    const failure: unknown = await apply(env).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure, 'apply was expected to fail').toBeDefined();
    expect(failure).toMatchObject({ code: 1 });
    const { stdout, stderr } = failure as {
      readonly stdout?: string;
      readonly stderr?: string;
    };
    const text = `${stdout ?? ''}${stderr ?? ''}`;
    // A diagnostic is printed for a human; it must not carry the secret it failed on.
    expect(text).not.toContain(PIN);
    return text;
  };

  const fileWith = async (name: string, contents: string): Promise<string> => {
    const path = join(world.dir, name);
    await writeFile(path, contents);
    return path;
  };

  it('takes the passphrase FILE over an inline passphrase, even a correct one', async () => {
    const path = await fileWith('pin.txt', PIN);

    await apply({ [PASS_FILE]: path, [PASS]: WRONG });

    expect(await applied()).toBe(true);
  }, 60_000);

  it('does not fall back to a correct inline passphrase when the file is wrong', async () => {
    const path = await fileWith('wrong.txt', WRONG);

    await expect(apply({ [PASS_FILE]: path, [PASS]: PIN })).rejects.toMatchObject({
      code: 1,
    });

    expect(await applied()).toBe(false);
  }, 60_000);

  it('takes an inline passphrase over a keyfile, even a broken one', async () => {
    await apply({ [PASS]: PIN, [KEYFILE]: join(world.dir, 'no-such-keyfile') });

    expect(await applied()).toBe(true);
  }, 60_000);

  it('falls back to the machine key when no channel is set — and that cannot open a PIN', async () => {
    // A hardened store has no machine slot, so the SMOOTH default must be refused, not
    // silently accepted.
    await expect(apply({})).rejects.toMatchObject({ code: 1 });

    expect(await applied()).toBe(false);
  }, 60_000);

  it('keeps the PIN to the file it was given, and out of everything the apply wrote or said', async () => {
    const path = await fileWith('pin.txt', PIN);

    const { stdout, stderr } = await apply({ [PASS_FILE]: path });
    expect(await applied()).toBe(true);

    /**
     * The file is the channel, so the secret lives there by contract — and nowhere else: not in
     * the config, not in a blob, not in the daemon log, and not in what the CLI printed. The
     * last one matters most: a terminal is the surface an operator is most likely to paste.
     */
    const inspected = await world.assertNoLeaks(
      [
        { label: 'the PIN', value: PIN, allowedPaths: ['pin.txt'] },
        { label: 'the endpoint key', value: token },
      ],
      { "the CLI's stdout": stdout, "the CLI's stderr": stderr },
    );
    expect(inspected).toBeGreaterThan(2);
    // The streams really were captured; scanning empty strings would prove nothing.
    expect(`${stdout}${stderr}`.length).toBeGreaterThan(0);
  }, 60_000);

  it('accepts a file written the way an editor or `echo` leaves it', async () => {
    const path = await fileWith('pin-lf.txt', `${PIN}\n`);

    await apply({ [PASS_FILE]: path });

    expect(await applied()).toBe(true);
  }, 60_000);

  it('accepts a CRLF file, so a Windows-authored secret is not silently wrong', async () => {
    const path = await fileWith('pin-crlf.txt', `${PIN}\r\n`);

    await apply({ [PASS_FILE]: path });

    expect(await applied()).toBe(true);
  }, 60_000);

  /**
   * Every case here pairs the broken channel with a CORRECT lower-priority one. If the CLI
   * quietly treated the broken channel as absent, the apply would SUCCEED — so the refusal
   * itself is evidence, and the diagnostic says which layer produced it.
   */
  describe('an unusable channel is an error, never a fallback', () => {
    it('refuses a missing file and names the variable, not the secret', async () => {
      const path = join(world.dir, 'absent.txt');

      const text = await applyFails({ [PASS_FILE]: path, [PASS]: PIN });

      expect(text).toContain(PASS_FILE);
      expect(text).toContain('could not read');
      expect(await applied()).toBe(false);
    }, 60_000);

    it('refuses a directory in place of a file', async () => {
      const path = join(world.dir, 'a-directory');
      await mkdir(path, { recursive: true });

      const text = await applyFails({ [PASS_FILE]: path, [PASS]: PIN });

      expect(text).toContain('not a regular file');
      expect(await applied()).toBe(false);
    }, 60_000);

    it('refuses a file past the size cap instead of reading it all', async () => {
      const oversized = MAX_PASSPHRASE_FILE_BYTES + 1;
      const path = await fileWith('huge.txt', 'x'.repeat(oversized));

      const text = await applyFails({ [PASS_FILE]: path, [PASS]: PIN });

      // Names the ceiling it enforced, so "the content happened to be a wrong PIN" cannot
      // stand in for the cap.
      expect(text).toContain('read ceiling');
      expect(text).toContain(String(MAX_PASSPHRASE_FILE_BYTES));
      expect(text).toContain(String(oversized));
      expect(await applied()).toBe(false);
    }, 60_000);

    it('refuses an empty file — a misconfiguration, never "unset"', async () => {
      const path = await fileWith('empty.txt', '\n');

      const text = await applyFails({ [PASS_FILE]: path, [PASS]: PIN });

      expect(text).toContain('is empty');
      expect(await applied()).toBe(false);
    }, 60_000);

    it('refuses a whitespace-only inline passphrase rather than falling through to the keyfile', async () => {
      // A recovery keyfile that really opens this store: were the blank variable treated as
      // absent, the next channel down would unlock and the apply would go through.
      const keyfile = join(world.dir, 'recovery.key');
      const operator = await world.unlock(PIN);
      expect(
        (await operator.exportRecovery({ kind: 'passphrase', passphrase: PIN }, keyfile)).ok,
      ).toBe(true);
      expect(existsSync(keyfile)).toBe(true);

      const text = await applyFails({ [PASS]: '   ', [KEYFILE]: keyfile });

      expect(text).toContain(PASS);
      expect(text).toContain('set but empty');
      expect(await applied()).toBe(false);

      // And that keyfile really is a working channel on its own.
      await apply({ [KEYFILE]: keyfile });
      expect(await applied()).toBe(true);
    }, 60_000);
  });
});
