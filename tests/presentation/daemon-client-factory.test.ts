// The seam that lets a socket-level test reach a tool result instead of GATEWAY_UNAVAILABLE:
// a call reaches the injected client, each account gets its own, and retiring one destroys it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as netConnect } from 'node:net';
import { Api, helpers } from 'telegram';
import type { TelegramClient } from 'telegram';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { daemon } from '../../src/presentation/mcp/daemon.js';
import {
  daemonAddress,
  EncryptedFileSessionStore,
} from '../../src/infrastructure/index.js';
import { FileConfigRepository } from '../../src/infrastructure/config/file-config-repository.js';
import { SealedPolicyRepository } from '../../src/infrastructure/config/sealed-policy-repository.js';
import {
  hashEndpointToken,
  mintEndpointToken,
} from '../../src/infrastructure/endpoint-token.js';
import { OperatorClient } from '../../src/presentation/operator/client.js';
import { SessionRef, type SessionRefValue } from '../../src/domain/index.js';
import { CHEAP_KDF, SocketClientTransport } from '../_support/socket-mcp-client.js';

const unwrapRef = (
  result: ReturnType<typeof SessionRef.create>,
): SessionRefValue => {
  if (!result.ok) throw new Error('invalid test session ref');
  return result.value;
};

const PIN = 'correct-horse-battery';
const SCOPED_ID = 100;

const scopedUser = (): Api.User =>
  new Api.User({
    id: helpers.returnBigInt(SCOPED_ID),
    accessHash: helpers.returnBigInt(0),
    firstName: 'Scoped',
  });

const scopedPeer = (): Api.TypeInputPeer =>
  new Api.InputPeerUser({
    userId: helpers.returnBigInt(SCOPED_ID),
    accessHash: helpers.returnBigInt(0),
  });

// Just enough surface for buildBinding to mint a real scoped binding and for list_dialogs to run.
class FakeTelegramClient {
  public connectCalls = 0;
  public destroyCalls = 0;
  public connected = false;
  public readonly sender = {
    userDisconnected: false,
    reconnect: (): void => undefined,
    _reconnect: (): Promise<void> => Promise.resolve(),
  };
  public readonly _sender = this.sender;
  public _createExportedSender(): typeof this.sender {
    return this.sender;
  }
  public connect(): Promise<void> {
    this.connectCalls += 1;
    this.connected = true;
    return Promise.resolve();
  }
  public isUserAuthorized(): Promise<boolean> {
    return Promise.resolve(true);
  }
  public getMe(): Promise<Api.User> {
    return Promise.resolve(
      new Api.User({ id: helpers.returnBigInt(7), firstName: 'Self' }),
    );
  }
  public getDialogs(): Promise<
    readonly { entity: Api.User; inputEntity: Api.TypeInputPeer }[]
  > {
    return Promise.resolve([{ entity: scopedUser(), inputEntity: scopedPeer() }]);
  }
  public async *iterDialogs(): AsyncGenerator<{
    readonly entity: Api.User;
    readonly inputEntity: Api.TypeInputPeer;
    readonly unreadCount: number;
    readonly pinned: boolean;
  }> {
    await Promise.resolve();
    yield {
      entity: scopedUser(),
      inputEntity: scopedPeer(),
      unreadCount: 0,
      pinned: false,
    };
  }
  public invoke<R extends Api.AnyRequest>(request: R): Promise<R['__response']> {
    if (request instanceof Api.messages.GetDialogFilters) {
      return Promise.resolve(
        new Api.messages.DialogFilters({ filters: [] }) as R['__response'],
      );
    }
    // list_dialogs refreshes metadata for the page it is about to return.
    if (request instanceof Api.messages.GetPeerDialogs) {
      return Promise.resolve(
        new Api.messages.PeerDialogs({
          dialogs: [
            new Api.Dialog({
              peer: new Api.PeerUser({ userId: helpers.returnBigInt(SCOPED_ID) }),
              topMessage: 0,
              readInboxMaxId: 0,
              readOutboxMaxId: 0,
              unreadCount: 3,
              unreadMentionsCount: 0,
              unreadReactionsCount: 0,
              notifySettings: new Api.PeerNotifySettings({}),
            }),
          ],
          messages: [],
          chats: [],
          users: [scopedUser()],
          state: new Api.updates.State({
            pts: 1,
            qts: 1,
            date: 1,
            seq: 1,
            unreadCount: 0,
          }),
        }) as R['__response'],
      );
    }
    return Promise.reject(new Error(`unexpected request: ${request.className}`));
  }
  public destroy(): Promise<void> {
    this.destroyCalls += 1;
    this.connected = false;
    return Promise.resolve();
  }
  public disconnect(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }
}

describe.skipIf(process.platform === 'win32')(
  'daemon clientFactory seam (socket level)',
  () => {
    let dir: string;
    let sessionDir: string;
    let address: string;
    const tokenA = mintEndpointToken();
    const tokenB = mintEndpointToken();
    const clients = new Map<string, FakeTelegramClient>();
    const factoryCalls: string[] = [];
    const exits: number[] = [];
    const openClients: Client[] = [];
    let operatorClient: OperatorClient | undefined;
    let daemonRunning = false;
    let signalBaseline = 0;
    let daemonSignalListeners: {
      readonly signal: 'SIGINT' | 'SIGTERM';
      readonly listener: NodeJS.SignalsListener;
    }[] = [];

    beforeAll(() => {
      signalBaseline =
        process.listenerCount('SIGTERM') + process.listenerCount('SIGINT');
    });
    // A daemon that outlives its case keeps sockets and one-shot signal handlers alive.
    afterAll(() => {
      expect(
        process.listenerCount('SIGTERM') + process.listenerCount('SIGINT'),
      ).toBe(signalBaseline);
    });

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'tmcp-factory-'));
      sessionDir = join(dir, 'secrets');
      clients.clear();
      factoryCalls.length = 0;
      exits.length = 0;
      openClients.length = 0;
      operatorClient = undefined;
      daemonRunning = false;
      daemonSignalListeners = [];
    });
    // Runs whether or not the assertions passed: a leaked daemon keeps sockets and signal
    // handlers alive for every later case in the process.
    afterEach(async () => {
      for (const client of openClients) {
        await client.close().catch(() => undefined);
      }
      operatorClient?.close();
      if (daemonRunning) {
        process.emit('SIGTERM', 'SIGTERM');
        for (let i = 0; i < 300 && exits.length === 0; i += 1) {
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(exits).toEqual([0]);
      }
      // The daemon arms `process.once` for both signals; only the one we raised is consumed.
      for (const { signal, listener } of daemonSignalListeners) {
        process.off(signal, listener);
      }
      await rm(dir, { recursive: true, force: true });
    });

    const seed = async (): Promise<string> => {
      const configPath = join(dir, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          endpoints: [
            {
              name: 'reader-a',
              session: 'acct-a',
              scope: { chats: [String(SCOPED_ID)], folders: [] },
              verbs: ['read'],
              tokenHash: hashEndpointToken(tokenA),
            },
            {
              name: 'reader-b',
              session: 'acct-b',
              scope: { chats: [String(SCOPED_ID)], folders: [] },
              verbs: ['read'],
              tokenHash: hashEndpointToken(tokenB),
            },
          ],
        }),
      );
      const store = new EncryptedFileSessionStore({
        directory: sessionDir,
        keySource: { kind: 'passphrase', passphrase: PIN },
        kdf: CHEAP_KDF,
      });
      for (const ref of ['acct-a', 'acct-b']) {
        expect(
          (
            await store.save({
              sessionRef: unwrapRef(SessionRef.create(ref)),
              secret: '1ApWaPpa.Telegram.SESSION.string',
              apiId: 1234567,
              apiHash: 'deadbeefcafedeadbeefcafedeadbeef',
            })
          ).ok,
        ).toBe(true);
      }
      expect((await store.savePolicy(await readFile(configPath))).ok).toBe(true);
      return configPath;
    };

    const start = async (configPath: string): Promise<void> => {
      const parser = new FileConfigRepository({ filePath: configPath });
      const before = {
        SIGINT: new Set(process.listeners('SIGINT')),
        SIGTERM: new Set(process.listeners('SIGTERM')),
      };
      await daemon({
        makeConfigRepository: (store) =>
          new SealedPolicyRepository({ configPath, parser, store }),
        plainConfigRepository: parser,
        configParser: parser,
        sessionDir,
        sessionKey: { kind: 'machine' },
        auditLogPath: join(dir, 'audit.log'),
        mediaRootDir: join(dir, 'media'),
        logger: () => undefined,
        exit: (code: number) => {
          exits.push(code);
        },
        clientFactory: (sessionRef: string) => {
          factoryCalls.push(sessionRef);
          const fake = new FakeTelegramClient();
          clients.set(sessionRef, fake);
          return fake as unknown as TelegramClient;
        },
      });
      daemonRunning = true;
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        for (const listener of process.listeners(signal)) {
          if (!before[signal].has(listener)) {
            daemonSignalListeners.push({ signal, listener });
          }
        }
      }
      address = daemonAddress(sessionDir);
      let up = false;
      for (let i = 0; i < 100 && !up; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        up = await new Promise<boolean>((r) => {
          const probe = netConnect(address);
          probe.once('connect', () => {
            probe.destroy();
            r(true);
          });
          probe.once('error', () => {
            r(false);
          });
        });
      }
      expect(up).toBe(true);
    };

    const openOperator = async (): Promise<OperatorClient> => {
      const operator = new OperatorClient({
        sessionDir,
        daemonCommand: { execPath: process.execPath, args: ['-e', ''] },
      });
      expect((await operator.connect()).ok).toBe(true);
      operatorClient = operator;
      expect(
        (await operator.authenticate({ kind: 'passphrase', passphrase: PIN })).ok,
      ).toBe(true);
      return operator;
    };

    const openMcp = async (token: string): Promise<Client> => {
      const client = new Client({ name: 'factory-test', version: '0.0.0' });
      openClients.push(client);
      await client.connect(new SocketClientTransport(address, { v: 1, token }));
      return client;
    };

    it('a tool call crosses the socket and reaches the injected client', async () => {
      const configPath = await seed();
      await start(configPath);
      await openOperator();

      const mcp = await openMcp(tokenA);
      const result = await mcp.callTool({ name: 'list_dialogs', arguments: {} });

      expect(result.isError).not.toBe(true);
      expect(factoryCalls).toEqual(['acct-a']);
      expect(clients.get('acct-a')?.connectCalls).toBe(1);
    }, 20_000);

    it('each account gets its own client, keyed by sessionRef', async () => {
      const configPath = await seed();
      await start(configPath);
      await openOperator();

      const a = await openMcp(tokenA);
      const b = await openMcp(tokenB);
      expect(
        (await a.callTool({ name: 'list_dialogs', arguments: {} })).isError,
      ).not.toBe(true);
      expect(
        (await b.callTool({ name: 'list_dialogs', arguments: {} })).isError,
      ).not.toBe(true);

      expect([...factoryCalls].sort()).toEqual(['acct-a', 'acct-b']);
      expect(clients.get('acct-a')).not.toBe(clients.get('acct-b'));
    }, 20_000);

    it('retiring one account destroys only that account client', async () => {
      const configPath = await seed();
      await start(configPath);
      const operator = await openOperator();

      const a = await openMcp(tokenA);
      const b = await openMcp(tokenB);
      await a.callTool({ name: 'list_dialogs', arguments: {} });
      await b.callTool({ name: 'list_dialogs', arguments: {} });

      expect((await operator.removeAccount('acct-a')).ok).toBe(true);
      expect(clients.get('acct-a')?.destroyCalls).toBeGreaterThanOrEqual(1);
      expect(clients.get('acct-b')?.destroyCalls).toBe(0);
    }, 20_000);
  },
);
