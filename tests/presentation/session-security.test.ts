/**
 * The PIN and the recovery keyfile, as an operator experiences them: through the operator
 * socket of a real daemon, and across a restart — because a posture change that lives only in
 * a running process's memory is not a posture change. One PIN covers every account on the
 * machine, so each case runs with two sealed sessions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TelegramClient } from 'telegram';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
  hashEndpointToken,
  mintEndpointToken,
} from '../../src/infrastructure/endpoint-token.js';
import type { SessionKeySource } from '../../src/application/index.js';
import { SocketClientTransport } from '../_support/socket-mcp-client.js';
import { FakeTelegramClient } from '../_support/fake-telegram-client.js';
import { E2EWorld } from '../_support/e2e-world.js';
import { guardProcessResources } from '../_support/resource-guards.js';

const PIN = 'correct-horse-battery';
const NEW_PIN = 'a-different-secret-entirely';
const SCOPED_ID = 100;

const endpoint = (name: string, session: string, token: string): unknown => ({
  name,
  session,
  scope: { chats: [String(SCOPED_ID)], folders: [] },
  verbs: ['read'],
  tokenHash: hashEndpointToken(token),
});

describe.skipIf(process.platform === 'win32')('session security over the operator plane', () => {
  guardProcessResources();
  const tokenA = mintEndpointToken();
  const tokenB = mintEndpointToken();
  let world: E2EWorld;
  let clients: Client[];

  const CONFIG = {
    version: 1,
    endpoints: [
      endpoint('reader-a', 'acct-a', tokenA),
      endpoint('reader-b', 'acct-b', tokenB),
    ],
  };

  const startDaemon = (): Promise<void> =>
    world.startDaemon({
      clientFactory: () => new FakeTelegramClient(SCOPED_ID) as unknown as TelegramClient,
    });

  beforeEach(async () => {
    clients = [];
    world = await E2EWorld.create('tmcp-security-');
  });
  afterEach(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await world.dispose();
    expect(world.exitCodes()).toEqual([0]);
  });

  // True when this endpoint can actually read — the observable that a posture change must not
  // quietly break, and must not quietly leave open either.
  const reads = async (token: string): Promise<boolean> => {
    const client = new Client({ name: 'security-test', version: '0.0.0' });
    clients.push(client);
    await client.connect(new SocketClientTransport(world.address(), { v: 1, token }));
    const result = await client.callTool({ name: 'list_dialogs', arguments: {} });
    await client.close();
    return result.isError !== true;
  };

  const refusalOf = async (token: string): Promise<string> => {
    const client = new Client({ name: 'security-test', version: '0.0.0' });
    clients.push(client);
    await client.connect(new SocketClientTransport(world.address(), { v: 1, token }));
    const result = await client.callTool({ name: 'list_dialogs', arguments: {} });
    await client.close();
    expect(result.isError).toBe(true);
    return JSON.stringify(result.content);
  };

  const restart = async (): Promise<void> => {
    await world.stopDaemon();
    await startDaemon();
  };

  const passphrase = (value: string): SessionKeySource => ({
    kind: 'passphrase',
    passphrase: value,
  });

  describe('adding a PIN', () => {
    beforeEach(async () => {
      // SMOOTH: machine-bound, no operator secret anywhere.
      await world.seal({ config: CONFIG, sessionRefs: ['acct-a', 'acct-b'] });
      await startDaemon();
    });

    it('turns a machine-bound store into one that stays closed until the PIN is typed', async () => {
      expect(await reads(tokenA)).toBe(true);
      const operator = await world.unlockWith({ kind: 'machine' });

      expect((await operator.setPin({ kind: 'machine' }, passphrase(NEW_PIN))).ok).toBe(true);

      await restart();
      // The machine binding is gone, so the daemon's own key cannot open the store.
      expect(await refusalOf(tokenA)).toContain('SESSION_LOCKED');
      await world.unlock(NEW_PIN);
      // One PIN, every account on the machine.
      expect(await reads(tokenA)).toBe(true);
      expect(await reads(tokenB)).toBe(true);
    }, 30_000);
  });

  describe('changing and removing a PIN', () => {
    beforeEach(async () => {
      await world.seal({ config: CONFIG, sessionRefs: ['acct-a', 'acct-b'], pin: PIN });
      await startDaemon();
    });

    it('retires the old PIN for every account, and the new one survives a restart', async () => {
      const operator = await world.unlock(PIN);

      expect(
        (await operator.changePin(passphrase(PIN), passphrase(NEW_PIN))).ok,
      ).toBe(true);

      await restart();
      const fresh = await world.operator();
      expect((await fresh.authenticate(passphrase(PIN))).ok).toBe(false);
      expect(await refusalOf(tokenA)).toContain('SESSION_LOCKED');

      await world.unlockWith(passphrase(NEW_PIN));
      expect(await reads(tokenA)).toBe(true);
      expect(await reads(tokenB)).toBe(true);
    }, 30_000);

    it('leaves neither the old nor the new PIN in plaintext anywhere it wrote', async () => {
      const operator = await world.unlock(PIN);
      expect(
        (await operator.changePin(passphrase(PIN), passphrase(NEW_PIN))).ok,
      ).toBe(true);
      await restart();
      await world.unlockWith(passphrase(NEW_PIN));
      expect(await reads(tokenA)).toBe(true);

      // Every blob was rewritten under the new key; neither secret may be readable in any of
      // them, in the config, or in what the daemon logged while doing it.
      const inspected = await world.assertNoLeaks([
        { label: 'the old PIN', value: PIN },
        { label: 'the new PIN', value: NEW_PIN },
      ]);
      expect(inspected).toBeGreaterThan(2);
    }, 30_000);

    it('drops the authorization of a connection that was authenticated with the old PIN', async () => {
      const changing = await world.unlock(PIN);
      const bystander = await world.unlock(PIN);
      expect((await bystander.listAccounts()).ok).toBe(true);

      expect(
        (await changing.changePin(passphrase(PIN), passphrase(NEW_PIN))).ok,
      ).toBe(true);

      // The credential it proved is no longer a credential.
      expect((await bystander.listAccounts()).ok).toBe(false);
    }, 30_000);

    it('returns the store to machine binding, and the old PIN stops being one', async () => {
      const operator = await world.unlock(PIN);

      expect((await operator.removePin(passphrase(PIN))).ok).toBe(true);

      await restart();
      // SMOOTH again: the daemon opens its own store, with nothing typed.
      expect(await reads(tokenA)).toBe(true);
      const fresh = await world.operator();
      expect((await fresh.authenticate(passphrase(PIN))).ok).toBe(false);
    }, 30_000);
  });

  /**
   * The throttle after a wrong PIN is a property of the STORE, not of a socket. Reconnecting is
   * the first thing anyone tries when a prompt starts refusing them, so a cooldown that a new
   * connection resets is no cooldown at all.
   */
  describe('the brute-force cooldown', () => {
    beforeEach(async () => {
      await world.seal({ config: CONFIG, sessionRefs: ['acct-a', 'acct-b'], pin: PIN });
      await startDaemon();
    });

    it('outlives the connection that earned it, and the right PIN still opens the store after', async () => {
      const first = await world.operator();
      // The first typo is free; the second arms the cooldown.
      expect((await first.authenticate(passphrase('wrong-one'))).ok).toBe(false);
      expect((await first.authenticate(passphrase('wrong-two'))).ok).toBe(false);
      // Even the correct credential is refused while it is open — the throttle is unconditional.
      expect((await first.authenticate(passphrase(PIN))).ok).toBe(false);
      first.close();

      const second = await world.operator();
      expect(
        (await second.authenticate(passphrase(PIN))).ok,
        'a fresh connection must not reset the throttle',
      ).toBe(false);
      expect(await refusalOf(tokenA)).toContain('SESSION_LOCKED');

      // It is a delay, not a lockout: once it elapses the correct PIN works on that same
      // new connection.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect((await second.authenticate(passphrase(PIN))).ok).toBe(true);
      expect(await reads(tokenA)).toBe(true);
    }, 30_000);

    it('authorizes one connection at a time: a second one starts with nothing', async () => {
      const authorized = await world.unlock(PIN);
      expect((await authorized.listAccounts()).ok).toBe(true);

      const bystander = await world.operator();

      // Being connected is not being authenticated, however the neighbour got in.
      expect((await bystander.listAccounts()).ok).toBe(false);
    }, 30_000);
  });

  describe('the recovery keyfile', () => {
    let keyfile = '';

    beforeEach(async () => {
      await world.seal({ config: CONFIG, sessionRefs: ['acct-a', 'acct-b'], pin: PIN });
      await startDaemon();
      keyfile = join(world.dir, 'recovery.key');
      const operator = await world.unlock(PIN);
      expect((await operator.exportRecovery(passphrase(PIN), keyfile)).ok).toBe(true);
      expect(existsSync(keyfile)).toBe(true);
    });

    it('opens the store it was exported from, without the PIN, after a restart', async () => {
      await restart();
      expect(await refusalOf(tokenA)).toContain('SESSION_LOCKED');

      await world.unlockWith({ kind: 'keyfile', keyfilePath: keyfile });

      expect(await reads(tokenA)).toBe(true);
      expect(await reads(tokenB)).toBe(true);
    }, 30_000);

    it('keeps its slot through a policy apply, so a config change does not revoke recovery', async () => {
      const operator = await world.unlockWith({ kind: 'keyfile', keyfilePath: keyfile });
      expect(
        (await operator.applyPolicy(JSON.stringify(CONFIG))).ok,
        'the keyfile is a full credential, not a read-only one',
      ).toBe(true);

      await restart();
      await world.unlockWith({ kind: 'keyfile', keyfilePath: keyfile });
      expect(await reads(tokenA)).toBe(true);
      // And the PIN it was exported alongside still works.
      await restart();
      await world.unlock(PIN);
      expect(await reads(tokenA)).toBe(true);
    }, 30_000);

    it('refuses a keyfile that is not the exported one', async () => {
      await restart();
      const impostor = join(world.dir, 'not-the-key');
      const operator = await world.operator();

      expect(
        (await operator.authenticate({ kind: 'keyfile', keyfilePath: impostor })).ok,
      ).toBe(false);
      expect(await refusalOf(tokenA)).toContain('SESSION_LOCKED');
    }, 30_000);
  });
});
