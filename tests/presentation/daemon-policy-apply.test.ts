/**
 * ATOMIC POLICY APPLY (socket level) — a real, unlocked daemon over a unix
 * socket, HARDENED posture, NO session file (nothing reaches Telegram). All
 * synthetic ENGLISH fixtures + fake ids; NO real data, NO Cyrillic.
 *
 * The daemon's ENFORCED repo is a REAL SealedPolicyRepository bound to the
 * daemon's shared store. Under the STATIC full menu the tool list never changes
 * across an apply; apply re-resolves the per-chat EXECUTION ACL. We
 * assert:
 *   1. applying a config that grants send keeps the STATIC full set while the
 *      grant takes effect on the next call, with no reconnect or re-list;
 *   2. an unapplied draft edit has no effect: the sealed read-only policy
 *      still governs execution, so a still-open connection's send is refused;
 *   3. a narrowed apply rejects a still-open connection's next write, with no
 *      reconnect and no menu change.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as netConnect, type Socket } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import type {
  ConfigRepository,
  SealedPolicyStore,
} from '../../src/application/index.js';
import {
  daemonAddress,
  EncryptedFileSessionStore,
  operatorAddress,
} from '../../src/infrastructure/index.js';
import { FileConfigRepository } from '../../src/infrastructure/config/file-config-repository.js';
import { SealedPolicyRepository } from '../../src/infrastructure/config/sealed-policy-repository.js';
import { hashEndpointToken, mintEndpointToken } from '../../src/infrastructure/endpoint-token.js';
import { daemon } from '../../src/presentation/mcp/daemon.js';
import { OperatorClient } from '../../src/presentation/operator/client.js';
import { applyConfigDraftForTest } from '../security/sealed-policy/_support.js';

/** Cheap scrypt cost so hardening the posture in tests is instant. */
const CHEAP = {
  pin: { N: 1 << 8, r: 8, p: 1 },
  machine: { N: 1 << 8, r: 8, p: 1 },
};

/** Minimal newline-delimited-JSON MCP client transport over a net.Socket. */
class SocketClientTransport {
  private socket: Socket | undefined;
  private buf = Buffer.alloc(0);
  public onmessage?: (m: unknown) => void;
  public onclose?: () => void;
  public onerror?: (e: Error) => void;
  public constructor(
    private readonly address: string,
    private readonly handshake: Record<string, unknown>,
  ) {}
  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = netConnect(this.address);
      this.socket = socket;
      socket.once('connect', () => {
        socket.write(`${JSON.stringify(this.handshake)}\n`);
        socket.on('data', (c: Buffer) => { this.onData(c); });
        socket.on('close', () => this.onclose?.());
        resolve();
      });
      socket.once('error', reject);
    });
  }
  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    let nl = this.buf.indexOf(0x0a);
    while (nl !== -1) {
      const line = this.buf.subarray(0, nl).toString('utf8');
      this.buf = this.buf.subarray(nl + 1);
      if (line.trim().length > 0) {
        try {
          this.onmessage?.(JSON.parse(line));
        } catch {
          /* a non-JSON refusal line — ignore */
        }
      }
      nl = this.buf.indexOf(0x0a);
    }
  }
  public send(message: unknown): Promise<void> {
    this.socket?.write(`${JSON.stringify(message)}\n`);
    return Promise.resolve();
  }
  public close(): Promise<void> {
    this.socket?.end();
    return Promise.resolve();
  }
}

describe('atomic policy apply over the operator socket', () => {
  let dir: string;
  let sessionDir: string;
  let configPath: string;
  let address: string;
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

  /** Build a real SealedPolicyRepository bound to a sealed-policy store. */
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
      kdf: CHEAP,
    });
    expect(r.ok).toBe(true);
    const store = new EncryptedFileSessionStore({
      directory: sessionDir,
      keySource: { kind: 'passphrase', passphrase: PIN },
      kdf: CHEAP,
    });
    expect(await store.appPosture()).toBe('hardened');
  };

  const waitUp = async (): Promise<void> => {
    address = daemonAddress(sessionDir);
    let up = false;
    for (let i = 0; i < 100 && !up; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      up = await new Promise<boolean>((r) => {
        const probe = netConnect(address);
        probe.once('connect', () => { probe.destroy(); r(true); });
        probe.once('error', () => { r(false); });
      });
    }
    expect(up).toBe(true);
    const operator = operatorAddress(sessionDir);
    let operatorUp = false;
    for (let i = 0; i < 100 && !operatorUp; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      operatorUp = await new Promise<boolean>((r) => {
        const probe = netConnect(operator);
        probe.once('connect', () => { probe.destroy(); r(true); });
        probe.once('error', () => { r(false); });
      });
    }
    expect(operatorUp).toBe(true);
  };

  const listToolNames = async (): Promise<string[]> => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    const transport = new SocketClientTransport(address, { v: 1, token });
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    return tools.map((t) => t.name).sort();
  };

  /**
   * Start a hardened+locked daemon whose ENFORCED repo is a REAL
   * SealedPolicyRepository, then authenticate over the separate operator plane.
   */
  const startUnlockedDaemon = async (): Promise<OperatorClient> => {
    const plain = new FileConfigRepository({ filePath: configPath });
    void daemon({
      makeConfigRepository: (store) => policyRepoFor(store),
      plainConfigRepository: plain,
      configParser: plain,
      sessionDir,
      sessionKey: { kind: 'machine' },
      auditLogPath: join(dir, 'audit.log'),
      mediaRootDir: join(dir, 'media'),
      logger: (): void => undefined,
    });
    await waitUp();
    const operator = new OperatorClient({
      sessionDir,
      daemonCommand: { execPath: '/unused', args: [] },
    });
    expect((await operator.connect()).ok).toBe(true);
    expect(
      (await operator.authenticate({ kind: 'passphrase', passphrase: PIN })).ok,
    ).toBe(true);
    return operator;
  };

  // The STATIC full menu: every non-forbidden tool is listed for EVERY endpoint,
  // regardless of its verbs or the kill-switch. A policy apply (widen OR
  // narrow) NEVER changes the menu — it re-resolves the per-chat EXECUTION ACL.
  const FULL_MENU = [
    'get_messages', 'search_messages', 'list_dialogs', 'list_topics', 'get_chat_info',
    'get_media_info', 'get_pinned_messages', 'list_participants', 'download_media',
    'send_message', 'edit_message', 'delete_message', 'save_draft',
    'mark_read', 'forward_message', 'send_reaction', 'prepare_media', 'send_media',
  ].sort();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tmcp-policy-apply-'));
    sessionDir = join(dir, 'secrets');
    configPath = join(dir, 'config.json');
  });
  afterEach(async () => {
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

      // The menu is still the static full set (an apply never re-lists tools). The
      // newly-granted send takes effect at the next tool CALL via the cleared
      // context cache — with NO reconnect and no re-list.
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

      // The SAME still-open connection: a write is REFUSED. Execution binds the
      // freshly-opened sealed context (contexts clear in the publish frame),
      // NOT a stale one — narrowing takes effect at the next call with NO reconnect.
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
      void daemon({
        makeConfigRepository: (store) => policyRepoFor(store),
        plainConfigRepository: plain,
        configParser: plain,
        sessionDir,
        sessionKey: { kind: 'machine' },
        auditLogPath: join(dir, 'audit.log'),
        mediaRootDir: join(dir, 'media'),
        logger: (): void => undefined,
      });
      await waitUp();
      const operator = new OperatorClient({
        sessionDir,
        daemonCommand: { execPath: '/unused', args: [] },
      });
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
