/**
 * LOCKED BUT SERVING + one-time shared unlock — the behaviour change at the heart
 * of this feature. Two complementary layers, all synthetic ENGLISH fixtures, NO
 * real data, NO Cyrillic, NO Telegram network:
 *
 *  A. CONNECTION LEVEL (in-memory MCP, real registry + real tool catalogue + real
 *     SessionGate): a LOCKED tool call fails closed with a secret-free
 *     SESSION_LOCKED error and the scoped client is NEVER touched; a ONE-TIME
 *     operator authentication then makes the SAME call — and a SECOND connection
 *     sharing the gate — both succeed WITHOUT re-unlocking.
 *
 *  B. SOCKET LEVEL (a real daemon over a unix socket, hardened app key, NO session
 *     file so nothing reaches Telegram): a locked daemon still ESTABLISHES —
 *     initialize + tools/list succeed and the menu is the endpoint's verb-gated
 *     set; a tool CALL returns the secret-free lock error; operator authentication
 *     refuses a wrong PIN (stays locked) and accepts the right one, after
 *     which calls on fresh connections are no longer SESSION_LOCKED (shared flip).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as netConnect, type Socket } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  AppErrorCode,
  SessionGate,
  type AppError,
  type EndpointExecutionContext,
  type LoadedConfiguration,
  type RuntimeUnlockableStore,
  type ConfigRepository,
} from '../../src/application/index.js';
import { PermissionVerb, type Endpoint } from '../../src/domain/index.js';
import { ok, type Result } from '../../src/shared/index.js';
import { createConnectionServer } from '../../src/presentation/mcp/endpoint-stack.js';
import {
  daemon,
  lockedContextProvider,
} from '../../src/presentation/mcp/daemon.js';
import {
  daemonAddress,
  EncryptedFileSessionStore,
  operatorAddress,
} from '../../src/infrastructure/index.js';
import { FileConfigRepository } from '../../src/infrastructure/config/file-config-repository.js';
import { SealedPolicyRepository } from '../../src/infrastructure/config/sealed-policy-repository.js';
import { hashEndpointToken, mintEndpointToken } from '../../src/infrastructure/endpoint-token.js';
import { OperatorClient } from '../../src/presentation/operator/client.js';
import {
  buildEndpoint,
  noKillSwitch,
  resolvedScope,
  RecordingAuditLog,
  StubRateLimiter,
  SpyScopedClient,
  FakeClock,
  NO_DENIED,
} from '../application/_support.js';

// A regex asserting the lock error leaks NO scope/chat/session/secret/path.
const SECRET_BEARING = /session\b|scope|chat|passphrase|\bpin\b|\/tmp|\/Users|\/home/i;

// The STATIC full menu: every non-forbidden tool is listed for EVERY endpoint
// (even a locked, read-only one) — execution is the sole ACL.
const FULL_MENU = [
  'get_messages',
  'search_messages',
  'list_dialogs',
  'list_topics',
  'get_chat_info',
  'get_media_info',
  'get_pinned_messages',
  'list_participants',
  'download_media',
  'send_message',
  'edit_message',
  'delete_message',
  'save_draft',
  'mark_read',
  'forward_message',
  'send_reaction',
  'prepare_media',
  'send_media',
].sort();

/** Pull the AppError code out of an isError CallToolResult (registry's shape). */
interface ToolResultView {
  readonly isError?: boolean;
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
}
const errorInfo = (
  result: unknown,
): { code?: string; message?: string } | undefined => {
  const view = result as ToolResultView;
  for (const block of view.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      try {
        const parsed = JSON.parse(block.text) as {
          error?: { code?: string; message?: string };
        };
        if (parsed.error !== undefined) return parsed.error;
      } catch {
        /* not JSON */
      }
    }
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// A. CONNECTION LEVEL — real registry + SessionGate, in-memory transport.
// ---------------------------------------------------------------------------

class FakeUnlockStore implements RuntimeUnlockableStore {
  public verifyUnlock(): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }
  public setActiveSource(): void {
    /* no-op fake */
  }
}

describe('locked-but-serving (connection level): fail-closed, secret-free, shared one-time unlock', () => {
  const ENDPOINT: Endpoint = buildEndpoint({ verbs: [PermissionVerb.Read] });
  const NAME = String(ENDPOINT.name);

  const open: { client: Client; close: () => Promise<void> }[] = [];
  afterEach(async () => {
    for (const o of open.splice(0)) await o.close();
  });

  /**
   * Build the daemon's shared plumbing: ONE SessionGate + ONE shared context
   * (with a spy client) + the SAME providerFor both connections use. The
   * providerFor is the REAL daemon chokepoint {@link lockedContextProvider} (NOT
   * a re-implementation), so this exercises the shipped lock decision. Gateway
   * acquisition is a SPY (`acquireCalls`): asserting it stays empty while locked
   * proves the daemon never touches the gateway before the unlock check.
   */
  const buildShared = (): {
    gate: SessionGate;
    spy: SpyScopedClient;
    acquireCalls: string[];
    providerFor: (
      name: string,
    ) => () => Promise<Result<EndpointExecutionContext, AppError>>;
  } => {
    const spy = new SpyScopedClient(ENDPOINT.name);
    const menu: LoadedConfiguration = {
      endpoints: [ENDPOINT],
      killSwitch: noKillSwitch(),
    };
    const authRepo: ConfigRepository = {
      load: (): Promise<Result<LoadedConfiguration, AppError>> =>
        Promise.resolve(ok(menu)),
    };
    const gate = new SessionGate(
      new FakeUnlockStore(),
      authRepo,
    );
    const sharedContext = (ep: Endpoint): EndpointExecutionContext => ({
      endpoint: ep,
      resolvedScope: resolvedScope(),
      overrides: new Map(),
      deniedVerbs: NO_DENIED,
      client: spy,
    });
    // The GATEWAY-acquisition seam the real daemon feeds `lockedContextProvider`.
    // Recording every call lets a locked call PROVE the gateway is never touched.
    const acquireCalls: string[] = [];
    const acquireContext = (ep: Endpoint): Promise<EndpointExecutionContext> => {
      acquireCalls.push(String(ep.name));
      return Promise.resolve(sharedContext(ep));
    };
    const providerFor = (
      name: string,
    ): (() => Promise<Result<EndpointExecutionContext, AppError>>) =>
      // These suites exercise LOCK behaviour, not key rotation — always authorize.
      lockedContextProvider(gate, acquireContext, name, () => true);
    return { gate, spy, acquireCalls, providerFor };
  };

  const connectOne = async (
    providerFor: (
      name: string,
    ) => () => Promise<Result<EndpointExecutionContext, AppError>>,
  ): Promise<Client> => {
    const { server } = createConnectionServer({
      contextProvider: providerFor(NAME),
      auditLog: new RecordingAuditLog(),
      rateLimiter: new StubRateLimiter(ok(undefined)),
      clock: new FakeClock(),
    });
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    open.push({ client, close: async () => { await client.close(); await server.close(); } });
    return client;
  };

  it('LOCKED: initialize + tools/list still succeed (the STATIC full menu)', async () => {
    const { providerFor } = buildShared();
    const client = await connectOne(providerFor);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(FULL_MENU);
  });

  it('LOCKED tool CALL: secret-free SESSION_LOCKED, and neither the gateway acquisition NOR the scoped client is EVER touched', async () => {
    const { spy, acquireCalls, providerFor } = buildShared();
    const client = await connectOne(providerFor);

    const result = await client.callTool({ name: 'list_dialogs', arguments: { limit: 50 } });
    const err = errorInfo(result);
    expect(err?.code).toBe('SESSION_LOCKED');
    // Names the one-time unlock command...
    expect(err?.message).toContain('npx secure-telegram-mcp start');
    // ...and leaks NO scope/chat/session/secret/path.
    expect(err?.message ?? '').not.toMatch(SECRET_BEARING);
    // FAIL-CLOSED (through the REAL daemon provider): the lock check short-circuits
    // BEFORE gateway acquisition — acquireContext is never called — so the scoped
    // client is never invoked. A reorder that acquired the gateway first would
    // push onto acquireCalls here.
    expect(acquireCalls).toEqual([]);
    expect(spy.calls).toEqual([]);
  });

  it('UNLOCKED but endpoint ABSENT from the ENFORCED menu: execution fails closed (plain menu never governs), gateway never touched', async () => {
    // The enforced menu carries ONLY the test endpoint; a connection bound (in the
    // locked window, off the plain menu) to a DIFFERENT name must NOT execute even
    // after a valid unlock — it re-resolves off the enforced menu and is denied.
    const { gate, acquireCalls, providerFor } = buildShared();
    const unlockRes = await gate.authenticateOperator({ kind: 'passphrase', passphrase: 'p' });
    expect(unlockRes.ok).toBe(true);

    const provider = providerFor('plain-only-widened-endpoint');
    const decision = await provider();
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error.code).toBe(AppErrorCode.SessionLocked);
    // Denied WITHOUT touching the gateway (enforcedEndpoint === undefined branch).
    expect(acquireCalls).toEqual([]);

    // Control: the ENFORCED endpoint DOES resolve + acquire post-unlock.
    const okDecision = await providerFor(NAME)();
    expect(okDecision.ok).toBe(true);
    expect(acquireCalls).toEqual([NAME]);
  });

  it('one shared operator unlock opens the same and subsequent connections', async () => {
    const shared = buildShared();
    const client1 = await connectOne(shared.providerFor);

    // While locked: fails closed.
    const locked = await client1.callTool({ name: 'list_dialogs', arguments: { limit: 50 } });
    expect(errorInfo(locked)?.code).toBe('SESSION_LOCKED');
    expect(shared.spy.calls).toEqual([]);

    // ONE actor unlocks the ONE shared gate.
    const unlockRes = await shared.gate.authenticateOperator({ kind: 'passphrase', passphrase: 'p' });
    expect(unlockRes.ok).toBe(true);

    // The SAME connection's next call now succeeds (reached the scoped client):
    // no error payload, and the spy client was actually invoked.
    const after = await client1.callTool({ name: 'list_dialogs', arguments: { limit: 50 } });
    expect(errorInfo(after)).toBeUndefined();
    expect(shared.spy.calls).toContain('listDialogs');

    // A SECOND connection (opened after unlock) also succeeds WITHOUT re-unlocking.
    const client2 = await connectOne(shared.providerFor);
    const onSecond = await client2.callTool({ name: 'list_dialogs', arguments: { limit: 50 } });
    expect(errorInfo(onSecond)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B. SOCKET LEVEL — a real locked daemon over a unix socket (no Telegram).
// ---------------------------------------------------------------------------

/** Cheap scrypt cost so hardening the app key in tests is instant. */
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

describe('locked-but-serving (socket level): real daemon, operator-plane unlock', () => {
  let dir: string;
  let sessionDir: string;
  let address: string;
  const token = mintEndpointToken();
  const PIN = 'correct-pin-value';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tmcp-locked-'));
    sessionDir = join(dir, 'secrets');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const openMcp = async (tok: string = token): Promise<Client> => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    const transport = new SocketClientTransport(address, { v: 1, token: tok });
    await client.connect(transport);
    return client;
  };

  /** Seal the test policy under the PIN (cheap KDF) — no session file. */
  const seedHardenedPolicy = async (policyPath: string): Promise<void> => {
    const seedStore = new EncryptedFileSessionStore({
      directory: sessionDir,
      keySource: { kind: 'passphrase', passphrase: PIN },
      kdf: CHEAP,
    });
    await seedStore.savePolicy(await readFile(policyPath));
    expect(await seedStore.appPosture()).toBe('hardened');
  };

  /** Poll the socket until the daemon is listening (sets `address`). */
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

  const openOperator = async (): Promise<OperatorClient> => {
    const operator = new OperatorClient({
      sessionDir,
      daemonCommand: { execPath: process.execPath, args: ['-e', ''] },
    });
    expect((await operator.connect()).ok).toBe(true);
    return operator;
  };

  it.skipIf(process.platform === 'win32')(
    'a malformed display draft cannot block operator recovery of the sealed policy',
    async () => {
      const plainPath = join(dir, 'plain.json');
      await writeFile(plainPath, '{"endpoints":"hand-edit typo"}');
      const enforcedPath = join(dir, 'enforced.json');
      await writeFile(
        enforcedPath,
        JSON.stringify({
          version: 1,
          endpoints: [
            {
              name: 'reader',
              session: 'main',
              scope: { chats: ['me'], folders: [] },
              verbs: ['read'],
              tokenHash: hashEndpointToken(token),
            },
          ],
        }),
      );
      await seedHardenedPolicy(enforcedPath);
      const plain = new FileConfigRepository({ filePath: plainPath });
      const enforced = new FileConfigRepository({ filePath: enforcedPath });
      const logs: string[] = [];
      void daemon({
        makeConfigRepository: (store) =>
          new SealedPolicyRepository({
            configPath: plainPath,
            parser: enforced,
            store,
          }),
        plainConfigRepository: plain,
        configParser: enforced,
        sessionDir,
        sessionKey: { kind: 'machine' },
        auditLogPath: join(dir, 'audit.log'),
        mediaRootDir: join(dir, 'media'),
        logger: (message) => {
          logs.push(message);
        },
      });
      await waitUp();

      const operator = await openOperator();
      expect(
        (await operator.authenticate({ kind: 'passphrase', passphrase: PIN })).ok,
      ).toBe(true);
      const client = await openMcp();
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      expect(logs.some((line) => line.includes('draft unavailable'))).toBe(true);
      await client.close();
      operator.close();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'operator authentication arms hardened idle auto-lock after a locked boot',
    async () => {
      const configPath = join(dir, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          endpoints: [
            {
              name: 'reader',
              session: 'main',
              scope: { chats: ['me'], folders: [] },
              verbs: ['read'],
              tokenHash: hashEndpointToken(token),
            },
          ],
        }),
      );
      await seedHardenedPolicy(configPath);
      const config = new FileConfigRepository({ filePath: configPath });
      let onExit!: (code: number) => void;
      const exited = new Promise<number>((resolve) => {
        onExit = resolve;
      });
      void daemon({
        makeConfigRepository: (store) =>
          new SealedPolicyRepository({ configPath, parser: config, store }),
        plainConfigRepository: config,
        configParser: config,
        sessionDir,
        sessionKey: { kind: 'machine' },
        auditLogPath: join(dir, 'audit.log'),
        mediaRootDir: join(dir, 'media'),
        logger: () => undefined,
        exit: onExit,
        env: { TELEGRAM_MCP_IDLE_HOURS: '0.00003' },
      });
      await waitUp();

      const operator = await openOperator();
      expect(
        (await operator.authenticate({ kind: 'passphrase', passphrase: PIN })).ok,
      ).toBe(true);
      operator.close();

      expect(
        await Promise.race([
          exited,
          new Promise<number>((resolve) => {
            setTimeout(() => {
              resolve(-1);
            }, 2_000);
          }),
        ]),
      ).toBe(0);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'corrupting policy.blob cannot downgrade operator authentication posture',
    async () => {
      const configPath = join(dir, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          endpoints: [
            {
              name: 'reader',
              session: 'main',
              scope: { chats: ['me'], folders: [] },
              verbs: ['read'],
              tokenHash: hashEndpointToken(token),
            },
          ],
        }),
      );
      await seedHardenedPolicy(configPath);
      const config = new FileConfigRepository({ filePath: configPath });
      void daemon({
        makeConfigRepository: (store) =>
          new SealedPolicyRepository({ configPath, parser: config, store }),
        plainConfigRepository: config,
        configParser: config,
        sessionDir,
        sessionKey: { kind: 'passphrase', passphrase: PIN },
        auditLogPath: join(dir, 'audit.log'),
        mediaRootDir: join(dir, 'media'),
        logger: () => undefined,
      });
      await waitUp();
      await writeFile(join(sessionDir, 'policy.blob'), 'corrupt');

      const operator = await openOperator();
      expect(await operator.status()).toMatchObject({
        ok: true,
        value: { posture: 'hardened' },
      });
      expect((await operator.listAccounts()).ok).toBe(false);
      operator.close();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'EXECUTION binds to the ENFORCED menu: a plain-only endpoint served in the locked window is DENIED after a valid unlock',
    async () => {
      // A SECOND endpoint that ONLY the locked-window plain menu carries.
      const widerToken = mintEndpointToken();
      const readerEp = {
        name: 'reader',
        session: 'main',
        scope: { chats: ['me'], folders: [] },
        verbs: ['read'],
        tokenHash: hashEndpointToken(token),
      };
      const widerEp = {
        name: 'wider',
        session: 'main',
        scope: { chats: ['me'], folders: [] },
        verbs: ['read'],
        tokenHash: hashEndpointToken(widerToken),
      };
      // PLAIN (locked-window, UNVERIFIED) menu lists BOTH endpoints...
      const plainPath = join(dir, 'plain.json');
      await writeFile(
        plainPath,
        JSON.stringify({ version: 1, endpoints: [readerEp, widerEp] }),
      );
      // ...but the encrypted, authenticated ENFORCED menu omits 'wider' entirely.
      const enforcedPath = join(dir, 'enforced.json');
      await writeFile(
        enforcedPath,
        JSON.stringify({ version: 1, endpoints: [readerEp] }),
      );

      await seedHardenedPolicy(enforcedPath);

      // plain != enforced: the daemon serves the plain menu while locked but
      // must bind EXECUTION to the enforced menu after unlock.
      const plain = new FileConfigRepository({ filePath: plainPath });
      const enforced = new FileConfigRepository({ filePath: enforcedPath });
      void daemon({
        makeConfigRepository: (store) =>
          new SealedPolicyRepository({
            configPath: plainPath,
            parser: enforced,
            store,
          }),
        plainConfigRepository: plain,
        configParser: plain,
        sessionDir,
        sessionKey: { kind: 'machine' },
        auditLogPath: join(dir, 'audit.log'),
        mediaRootDir: join(dir, 'media'),
        logger: () => undefined,
      });
      await waitUp();

      // Connect to 'wider' DURING the locked window (it is on the plain menu):
      // the PIN-free menu resolves + tools/list succeeds.
      const wider = await openMcp(widerToken);
      const { tools } = await wider.listTools();
      expect(tools.length).toBeGreaterThan(0);
      // Locked -> the call fails closed.
      expect(
        errorInfo(
          await wider.callTool({ name: 'list_dialogs', arguments: { limit: 50 } }),
        )?.code,
      ).toBe('SESSION_LOCKED');

      // Operator authentication publishes the ENFORCED reader-only menu.
      const operator = await openOperator();
      expect(
        (await operator.authenticate({ kind: 'passphrase', passphrase: PIN })).ok,
      ).toBe(true);

      // The STILL-OPEN 'wider' connection re-resolves off the ENFORCED menu,
      // which OMITS it -> STILL SESSION_LOCKED. Execution NEVER binds the plain
      // (locked-window) menu, even though it happily served the connection.
      const afterWider = await wider.callTool({
        name: 'list_dialogs',
        arguments: { limit: 50 },
      });
      expect(errorInfo(afterWider)?.code).toBe('SESSION_LOCKED');
      await wider.close();

      // Control: 'reader' (present in the enforced menu) is NO LONGER locked —
      // it reaches gateway acquisition (GATEWAY_UNAVAILABLE, no session file),
      // proving the gate opened and only 'wider' was denied on authz grounds.
      const reader = await openMcp(token);
      const afterReader = await reader.callTool({
        name: 'list_dialogs',
        arguments: { limit: 50 },
      });
      expect(errorInfo(afterReader)?.code).not.toBe('SESSION_LOCKED');
      await reader.close();
      operator.close();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a hardened+locked daemon establishes; calls stay locked until operator authentication (shared)',
    async () => {
      // config.json: one read-only endpoint keyed by `token`.
      const configPath = join(dir, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          endpoints: [
            {
              name: 'reader',
              session: 'main',
              scope: { chats: ['me'], folders: [] },
              verbs: ['read'],
              tokenHash: hashEndpointToken(token),
            },
          ],
        }),
      );

      // Seal a HARDENED policy blob under the PIN (cheap KDF) — no session file,
      // so nothing can reach Telegram even after unlock.
      await seedHardenedPolicy(configPath);

      // Start the daemon with NO PIN channel -> it comes up LOCKED yet serving.
      const plain = new FileConfigRepository({ filePath: configPath });
      void daemon({
        makeConfigRepository: (store) =>
          new SealedPolicyRepository({ configPath, parser: plain, store }),
        plainConfigRepository: plain,
        configParser: plain,
        sessionDir,
        sessionKey: { kind: 'machine' },
        auditLogPath: join(dir, 'audit.log'),
        mediaRootDir: join(dir, 'media'),
        logger: () => undefined,
      });

      await waitUp();

      // (1) LOCKED daemon ESTABLISHES: initialize + tools/list succeed, and the
      // menu is the STATIC full set (execution — not the menu — is the ACL).
      const client1 = await openMcp();
      const { tools } = await client1.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(FULL_MENU);

      // (2) A tool CALL while LOCKED -> secret-free SESSION_LOCKED.
      const lockedCall = await client1.callTool({
        name: 'list_dialogs',
        arguments: { limit: 50 },
      });
      const lockedErr = errorInfo(lockedCall);
      expect(lockedErr?.code).toBe('SESSION_LOCKED');
      expect(lockedErr?.message).toContain('npx secure-telegram-mcp start');
      expect(lockedErr?.message ?? '').not.toContain(token);
      expect(lockedErr?.message ?? '').not.toMatch(SECRET_BEARING);
      await client1.close();

      // (3) Wrong operator authentication is secret-free and stays locked.
      const operator = await openOperator();
      const wrong = await operator.authenticate({
        kind: 'passphrase',
        passphrase: 'not-the-pin',
      });
      expect(wrong.ok).toBe(false);
      if (!wrong.ok) expect(wrong.error).toBe('operator authentication failed');
      const stillLocked = await openMcp();
      const stillLockedCall = await stillLocked.callTool({
        name: 'list_dialogs',
        arguments: { limit: 50 },
      });
      expect(errorInfo(stillLockedCall)?.code).toBe('SESSION_LOCKED');
      await stillLocked.close();

      // (4) The right PIN authenticates this operator connection and opens the
      // daemon-wide gate once.
      expect(
        (await operator.authenticate({ kind: 'passphrase', passphrase: PIN })).ok,
      ).toBe(true);

      // (5) Fresh connections are NO LONGER SESSION_LOCKED (the shared gate flipped).
      // With no session file on disk the call now fails GATEWAY_UNAVAILABLE — which
      // proves the gate opened WITHOUT ever reaching Telegram. A second connection
      // behaves identically (shared, not per-connection).
      for (let n = 0; n < 2; n += 1) {
        const post = await openMcp();
        const postCall = await post.callTool({
          name: 'list_dialogs',
          arguments: { limit: 50 },
        });
        expect(errorInfo(postCall)?.code).not.toBe('SESSION_LOCKED');
        await post.close();
      }
      operator.close();
    },
  );
});

describe('per-call endpoint-key re-authorization (M10)', () => {
  const ENDPOINT: Endpoint = buildEndpoint({ verbs: [PermissionVerb.Read] });
  const NAME = String(ENDPOINT.name);

  const unlockedGate = (): SessionGate => {
    const menu: LoadedConfiguration = {
      endpoints: [ENDPOINT],
      killSwitch: noKillSwitch(),
    };
    return new SessionGate(
      new FakeUnlockStore(),
      {
        load: (): Promise<Result<LoadedConfiguration, AppError>> =>
          Promise.resolve(ok(menu)),
      },
      menu,
    );
  };

  it('a rotated/revoked key fails closed (ACL_DENIED) WITHOUT touching the gateway', async () => {
    const gate = unlockedGate();
    let acquired = false;
    const acquire = (): Promise<EndpointExecutionContext> => {
      acquired = true;
      return Promise.reject(new Error('gateway must not be acquired for a revoked key'));
    };
    // authorizeToken=false models the connection's key being rotated by a policy apply
    // AFTER it opened — the enforced endpoint still exists, but the key no longer
    // matches its tokenHash.
    const provider = lockedContextProvider(gate, acquire, NAME, () => false);

    const r = await provider();

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ACL_DENIED');
    expect(acquired).toBe(false); // the gateway is never touched on a revoked key
  });
});
