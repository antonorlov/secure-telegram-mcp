import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { Api, helpers } from 'telegram';
import type { TelegramClient } from 'telegram';

import {
  AppErrorCode,
  type Clock,
  type ScopedClient,
} from '../../src/application/index.js';
import {
  ChatId,
  PermissionVerb,
  PeerRefFactory,
  ResolvedScope,
  type PeerRef,
} from '../../src/domain/index.js';
import {
  GramjsTelegramGateway,
  UnicodeSanitizer,
} from '../../src/infrastructure/index.js';
import { isOk } from '../../src/shared/index.js';
import { unwrap } from '../../src/shared/result.js';
import { buildEndpoint, FakeClock } from '../application/_support.js';

const PEER_ID = 100;
const MESSAGE_ID = 42;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const user = (): Api.User =>
  new Api.User({
    id: helpers.returnBigInt(PEER_ID),
    accessHash: helpers.returnBigInt(0),
    firstName: 'Scoped',
  });

const mediaMessage = (): Api.Message =>
  new Api.Message({
    id: MESSAGE_ID,
    peerId: new Api.PeerUser({ userId: helpers.returnBigInt(PEER_ID) }),
    date: 1_750_000_000,
    message: '',
    // Photo-like media has no declared byte size, so only the runtime cap can
    // protect the destination.
    media: new Api.MessageMediaPhoto({}),
  });

class DownloadTelegramClient {
  public connected = true;
  public downloadCalls = 0;
  public reportProgress = true;
  public failAfterWrite = false;
  public returnBeforeWriteSettles = false;
  public readonly _sender = {
    userDisconnected: false,
    reconnect: (): void => undefined,
    _reconnect: (): Promise<void> => Promise.resolve(),
  };

  public constructor(public downloadBytes: number) {}

  public _createExportedSender(): typeof this._sender {
    return this._sender;
  }

  public connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  public disconnect(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }

  public destroy(): Promise<void> {
    this.connected = false;
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

  public async *iterDialogs(): AsyncGenerator<{
    readonly entity: Api.User;
    readonly inputEntity: Api.InputPeerUser;
    readonly unreadCount: number;
    readonly pinned: boolean;
  }> {
    await Promise.resolve();
    yield {
      entity: user(),
      inputEntity: new Api.InputPeerUser({
        userId: helpers.returnBigInt(PEER_ID),
        accessHash: helpers.returnBigInt(0),
      }),
      unreadCount: 0,
      pinned: false,
    };
  }

  public getMessages(): Promise<readonly Api.Message[]> {
    return Promise.resolve([mediaMessage()]);
  }

  public async downloadMedia(
    _message: Api.Message,
    options: {
      readonly outputFile?:
        | string
        | {
            readonly path?: string | Buffer;
            write(chunk: Uint8Array): boolean | Promise<boolean>;
            close?(): void;
          };
      readonly progressCallback?: (
        downloaded: ReturnType<typeof helpers.returnBigInt>,
        total: ReturnType<typeof helpers.returnBigInt>,
      ) => void | Promise<void>;
    },
  ): Promise<string | undefined> {
    this.downloadCalls += 1;
    const outputFile = options.outputFile;
    if (outputFile === undefined) return undefined;
    try {
      if (typeof outputFile === 'string') {
        await writeFile(outputFile, Buffer.alloc(this.downloadBytes, 1));
      } else {
        const writing = Promise.resolve(
          outputFile.write(Buffer.alloc(this.downloadBytes, 1)),
        );
        if (!this.returnBeforeWriteSettles) await writing;
      }
      if (this.reportProgress) {
        await options.progressCallback?.(
          helpers.returnBigInt(this.downloadBytes),
          helpers.returnBigInt(0),
        );
      }
      if (this.failAfterWrite) throw new Error('download failed');
      if (typeof outputFile === 'string') return outputFile;
      return typeof outputFile.path === 'string' ? outputFile.path : undefined;
    } finally {
      if (typeof outputFile !== 'string') outputFile.close?.();
    }
  }
}

const setup = async (
  fake: DownloadTelegramClient,
  cap: number,
  clock: Clock = new FakeClock(),
): Promise<{
  readonly root: string;
  readonly gateway: GramjsTelegramGateway;
  readonly client: ScopedClient;
  readonly peer: PeerRef;
}> => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-mcp-download-'));
  roots.push(root);
  const gateway = new GramjsTelegramGateway({
    apiId: 1,
    apiHash: 'test-hash',
    sessionSecret: 'test-session',
    mediaRootDir: root,
    sanitizer: new UnicodeSanitizer(),
    clock,
    clientFactory: (): TelegramClient => fake as unknown as TelegramClient,
  });
  const id = unwrap(ChatId.create(BigInt(PEER_ID)));
  const bound = await gateway.bindScopedClient({
    endpoint: buildEndpoint({
      verbs: [PermissionVerb.Read, PermissionVerb.ReadMedia],
    }),
    resolvedScope: unwrap(ResolvedScope.create([id])),
    overrides: new Map(),
    maxDownloadBytes: cap,
  });
  expect(isOk(bound)).toBe(true);
  if (!isOk(bound)) throw new Error(bound.error.message);
  return { root, gateway, client: bound.value, peer: PeerRefFactory.fromId(id) };
};

const downloadFiles = async (root: string): Promise<readonly string[]> => {
  try {
    return await readdir(join(root, 'downloads'));
  } catch {
    return [];
  }
};

describe('download_media runtime resource cap', () => {
  it('reports handle expiry from wall time while enforcing it monotonically', async () => {
    const fake = new DownloadTelegramClient(1);
    const clock: Clock = {
      nowMs: () => 42,
      nowIso: () => '2026-07-12T10:00:00.000Z',
    };
    const { root, gateway, client } = await setup(fake, 5, clock);
    const localPath = join(root, 'upload.txt');
    await writeFile(localPath, 'content');

    const result = await client.prepareMedia({ localPath });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.expiresAtIso).toBe('2026-07-12T10:05:00.000Z');
    }
    await gateway.dispose();
  });

  it('aborts unknown-size media at the progress boundary and removes the partial', async () => {
    const fake = new DownloadTelegramClient(10);
    const { root, gateway, client, peer } = await setup(fake, 5);

    const result = await client.downloadMedia({ peer, messageId: MESSAGE_ID });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.SizeCapExceeded);
    expect(await downloadFiles(root)).toEqual([]);
    await gateway.dispose();
  });

  it('post-checks the file even when an adapter never reports progress', async () => {
    const fake = new DownloadTelegramClient(10);
    fake.reportProgress = false;
    const { root, gateway, client, peer } = await setup(fake, 5);

    const result = await client.downloadMedia({ peer, messageId: MESSAGE_ID });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.SizeCapExceeded);
    expect(await downloadFiles(root)).toEqual([]);
    await gateway.dispose();
  });

  it('removes a partial file when Telegram fails after writing bytes', async () => {
    const fake = new DownloadTelegramClient(3);
    fake.failAfterWrite = true;
    const { root, gateway, client, peer } = await setup(fake, 5);

    const result = await client.downloadMedia({ peer, messageId: MESSAGE_ID });
    expect(result.ok).toBe(false);
    expect(await downloadFiles(root)).toEqual([]);
    await gateway.dispose();
  });

  it('publishes only a checked file at or below the cap', async () => {
    const fake = new DownloadTelegramClient(5);
    const { root, gateway, client, peer } = await setup(fake, 5);

    const result = await client.downloadMedia({ peer, messageId: MESSAGE_ID });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.sizeBytes).toBe(5);
      expect((await readFile(result.value.filePath)).length).toBe(5);
    }
    expect((await downloadFiles(root)).some((name) => name.includes('.part-'))).toBe(
      false,
    );
    await gateway.dispose();
  });

  it('waits for the output stream to close before checking and publishing it', async () => {
    const bytes = 8 * 1024 * 1024;
    const fake = new DownloadTelegramClient(bytes);
    fake.returnBeforeWriteSettles = true;
    const { gateway, client, peer } = await setup(fake, bytes);

    const result = await client.downloadMedia({ peer, messageId: MESSAGE_ID });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.sizeBytes).toBe(bytes);
      expect((await stat(result.value.filePath)).size).toBe(bytes);
    }
    await gateway.dispose();
  });
});

describe('prepare_media lifecycle and resource cap', () => {
  it('reserves the live-handle cap across concurrent filesystem checks', async () => {
    const fake = new DownloadTelegramClient(1);
    const { root, gateway, client } = await setup(fake, 5);
    const localPath = join(root, 'upload.txt');
    await writeFile(localPath, 'content');

    const results = await Promise.all(
      Array.from({ length: 65 }, () => client.prepareMedia({ localPath })),
    );

    expect(results.filter(isOk)).toHaveLength(64);
    const refused = results.filter((result) => !result.ok);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.error.code).toBe(AppErrorCode.QuotaExceeded);
    await gateway.dispose();
  });

  it('does not publish a handle when disposal overtakes filesystem checks', async () => {
    const fake = new DownloadTelegramClient(1);
    const { root, gateway, client } = await setup(fake, 5);
    const localPath = join(root, 'upload.txt');
    await writeFile(localPath, 'content');

    const preparing = client.prepareMedia({ localPath });
    const disposing = gateway.dispose();

    const result = await preparing;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.GatewayUnavailable);
    }
    await disposing;
  });
});
