/**
 * Atomic policy apply at socket level: a real, unlocked daemon over a unix socket in HARDENED
 * posture with no session file, so nothing can reach Telegram. The enforced repo is a real
 * SealedPolicyRepository, the static menu never changes across an apply, and apply re-resolves
 * the per-chat execution policy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type {
  ConfigRepository,
  SealedPolicyStore,
} from '../../src/application/index.js';
import { EncryptedFileSessionStore } from '../../src/infrastructure/index.js';
import { FileConfigRepository } from '../../src/infrastructure/config/file-config-repository.js';
import { SealedPolicyRepository } from '../../src/infrastructure/config/sealed-policy-repository.js';
import { hashEndpointToken, mintEndpointToken } from '../../src/infrastructure/endpoint-token.js';
import { OperatorClient } from '../../src/presentation/operator/client.js';
import { applyConfigDraftForTest } from '../security/sealed-policy/_support.js';
import { CHEAP_KDF, SocketClientTransport } from '../_support/socket-mcp-client.js';
import { DaemonHarness } from '../_support/daemon-harness.js';
import { guardProcessResources } from '../_support/resource-guards.js';

// Cheap scrypt cost so hardening the posture in tests is instant.

describe('atomic policy apply over the operator socket', () => {
  let dir: string;
  let sessionDir: string;
  let configPath: string;
  let address: string;
  // Tracked so teardown closes them even when a case fails mid-assertion.
  let harnesses: DaemonHarness[];
  let operators: OperatorClient[];
  let clients: Client[];
  const token = mintEndpointToken();
  const PIN = 'correct-pin-value';

  const readerEndpoint = (verbs: readonly string[]): Record<string, unknown> => ({
    name: 'reader',
    session: 'main',
    scope: { chats: ['me'], folders: [] },
    verbs,
    tokenHash: hashEndpointToken(token),
  });

  const writeConfig = async (verbs: readonly string[]): Promise<void> => {
    await writeFile(
      configPath,
      JSON.stringify({ version: 1, endpoints: [readerEndpoint(verbs)] }),
    );
  };

  // Build a real SealedPolicyRepository bound to a sealed-policy store.
  const policyRepoFor = (
    store: SealedPolicyStore,
  ): ConfigRepository =>
    new SealedPolicyRepository({
      configPath,
      parser: new FileConfigRepository({ filePath: configPath }),
      store,
      log: (): void => undefined,
    });

  /**
   * APPLY config.json to the sealed policy under the PIN. This ALSO establishes
   * the HARDENED posture (the policy blob gains a passphrase slot), so the daemon
   * comes up locked-but-serving until unlocked.
   */
  const applyPolicy = async (): Promise<void> => {
    const r = await applyConfigDraftForTest({
      configPath,
      sessionDir,
      source: { kind: 'passphrase', passphrase: PIN },
      kdf: CHEAP_KDF,
    });
    expect(r.ok).toBe(true);
    const store = new EncryptedFileSessionStore({
      directory: sessionDir,
      keySource: { kind: 'passphrase', passphrase: PIN },
      kdf: CHEAP_KDF,
    });
    expect(await store.appPosture()).toBe('hardened');
  };

  const listToolNames = async (): Promise<string[]> => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    clients.push(client);
    const transport = new SocketClientTransport(address, { v: 1, token });
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    return tools.map((t) => t.name).sort();
  };

  // Start a hardened+locked daemon whose ENFORCED repo is a REAL SealedPolicyRepository, then
  // authenticate over the separate operator plane.
  const startUnlockedDaemon = async (): Promise<OperatorClient> => {
    const plain = new FileConfigRepository({ filePath: configPath });
    const harness = await DaemonHarness.start({
      makeConfigRepository: (store) => policyRepoFor(store),
      plainConfigRepository: plain,
      configParser: plain,
      sessionDir,
      sessionKey: { kind: 'machine' },
      auditLogPath: join(dir, 'audit.log'),
      mediaRootDir: join(dir, 'media'),
    });
    harnesses.push(harness);
    address = harness.address();
    const operator = new OperatorClient({
      sessionDir,
      daemonCommand: { execPath: '/unused', args: [] },
    });
    operators.push(operator);
    expect((await operator.connect()).ok).toBe(true);
    expect(
      (await operator.authenticate({ kind: 'passphrase', passphrase: PIN })).ok,
    ).toBe(true);
    return operator;
  };

  /**
   * The STATIC full menu: every non-forbidden tool is listed for EVERY endpoint, regardless of
   * its verbs or the kill-switch. A policy apply (widen OR narrow) NEVER changes the menu — it
   * re-resolves the per-chat EXECUTION ACL.
   */
  const FULL_MENU = [
    'get_messages', 'search_messages', 'list_dialogs', 'list_topics', 'get_chat_info',
    'get_media_info', 'get_pinned_messages', 'list_participants', 'download_media',
    'send_message', 'edit_message', 'delete_message', 'save_draft',
    'mark_read', 'forward_message', 'send_reaction', 'prepare_media', 'send_media',
  ].sort();

  guardProcessResources();

  beforeEach(async () => {
    harnesses = [];
    operators = [];
    clients = [];
    dir = await mkdtemp(join(tmpdir(), 'tmcp-policy-apply-'));
    sessionDir = join(dir, 'secrets');
    configPath = join(dir, 'config.json');
  });
  // Removing a socket path does not close the server listening on it: every daemon started
  // here is shut down, and every client closed, before the fixture directory goes.
  afterEach(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    for (const operator of operators) operator.close();
    for (const harness of harnesses) {
      await harness.stop();
      expect(harness.exitCodes()).toEqual([0]);
    }
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'a widened policy applies live while the static menu stays unchanged',
    async () => {
      await writeConfig(['read']);
      await applyPolicy(); // sealed read-only, hardened
      const operator = await startUnlockedDaemon();

      const before = await listToolNames();
      expect(before).toEqual(FULL_MENU);

      // Grant send through the atomic operator application use case.
      await writeConfig(['read', 'send']);
      const applied = await operator.applyPolicy(
        JSON.stringify({ version: 1, endpoints: [readerEndpoint(['read', 'send'])] }),
      );
      expect(applied.ok).toBe(true);

      /**
       * The menu is still the static full set (an apply never re-lists tools). The
       * newly-granted send takes effect at the next tool CALL via the cleared context cache —
       * with NO reconnect and no re-list.
       */
      const after = await listToolNames();
      expect(after).toEqual(FULL_MENU);
      operator.close();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'an unapplied draft edit has no effect on the sealed read-only policy',
    async () => {
      await writeConfig(['read']);
      await applyPolicy(); // sealed read-only
      const operator = await startUnlockedDaemon();

      // Hold a live connection open across the draft edit.
      const live = new Client({ name: 'live', version: '0.0.0' });
      await live.connect(new SocketClientTransport(address, { v: 1, token }));

      // Edit config.json to grant send but DO NOT apply it: config.json is only a
      // draft, so the sealed (read-only) policy is unchanged.
      await writeConfig(['read', 'send']);

      // The still-open connection's send is REFUSED — the sealed read-only policy
      // governs, not the unsealed draft edit.
      const res = await live.callTool({
        name: 'send_message',
        arguments: { peer: { kind: 'me' }, text: 'blocked' },
      });
      expect(res.isError).toBe(true);
      await live.close();

      expect(await listToolNames()).toEqual(FULL_MENU);
      operator.close();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a narrowed apply re-resolves execution without reconnecting',
    async () => {
      await writeConfig(['read', 'send']);
      await applyPolicy(); // sealed read + send
      const operator = await startUnlockedDaemon();
      expect(await listToolNames()).toEqual(FULL_MENU);

      // Hold a live MCP connection open across the policy apply.
      const live = new Client({ name: 'live', version: '0.0.0' });
      await live.connect(new SocketClientTransport(address, { v: 1, token }));
      const liveBefore = (await live.listTools()).tools.map((t) => t.name);
      expect(liveBefore).toContain('send_message');

      // NARROW through the same atomic operator application path.
      await writeConfig(['read']);
      expect(
        (
          await operator.applyPolicy(
            JSON.stringify({ version: 1, endpoints: [readerEndpoint(['read'])] }),
          )
        ).ok,
      ).toBe(true);

      /**
       * The SAME still-open connection: a write is REFUSED. Execution binds the freshly-opened
       * sealed context (contexts clear in the publish frame), NOT a stale one — narrowing takes
       * effect at the next call with NO reconnect.
       */
      const res = await live.callTool({
        name: 'send_message',
        arguments: { peer: { kind: 'me' }, text: 'blocked' },
      });
      expect(res.isError).toBe(true);
      await live.close();

      const after = await listToolNames();
      expect(after).toEqual(FULL_MENU);
      operator.close();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'brute-force backoff: after two wrong PINs even the CORRECT PIN is refused, then recovers',
    async () => {
      await writeConfig(['read']);
      await applyPolicy(); // hardened -> operator authentication is required
      const plain = new FileConfigRepository({ filePath: configPath });
      harnesses.push(
        await DaemonHarness.start({
          makeConfigRepository: (store) => policyRepoFor(store),
          plainConfigRepository: plain,
          configParser: plain,
          sessionDir,
          sessionKey: { kind: 'machine' },
          auditLogPath: join(dir, 'audit.log'),
          mediaRootDir: join(dir, 'media'),
        }),
      );
      const operator = new OperatorClient({
        sessionDir,
        daemonCommand: { execPath: '/unused', args: [] },
      });
      operators.push(operator);
      expect((await operator.connect()).ok).toBe(true);

      const wrong = { kind: 'passphrase', passphrase: 'not-the-pin' } as const;
      const right = { kind: 'passphrase', passphrase: PIN } as const;

      // First typo is free; the second failure arms an exponential cooldown.
      expect((await operator.authenticate(wrong)).ok).toBe(false);
      expect((await operator.authenticate(wrong)).ok).toBe(false);

      // FAIL-CLOSED: during the cooldown even the CORRECT credential is refused
      // (the throttle is unconditional, so an attacker cannot probe through it).
      expect((await operator.authenticate(right)).ok).toBe(false);

      // The cooldown expires (base 1s after the second failure) and the correct
      // PIN authenticates again — the throttle is a delay, not a lockout.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect((await operator.authenticate(right)).ok).toBe(true);
      operator.close();
    },
    15_000,
  );
});
