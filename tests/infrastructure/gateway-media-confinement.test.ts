/**
 * Two-phase media upload CONFINEMENT — prepareMedia/sendMedia over REAL temp
 * directories and symlinks (node:fs), driven through a fake TelegramClient via
 * the `clientFactory` seam.
 *
 * Pinned here:
 *  - a path outside the media root is rejected; a symlink INSIDE the root that
 *    resolves outside is rejected (realpath-based confinement);
 *  - out-of-root and non-existent paths return the IDENTICAL error, so
 *    prepare_media is never a filesystem existence oracle over host paths;
 *  - a non-regular file (directory) is rejected Validation;
 *  - a file over the 50 MiB upload cap is rejected SizeCapExceeded (sparse
 *    file — the cap reads st_size, no real 50 MiB is written);
 *  - an inaccessible media root fails GatewayUnavailable, not open-ended;
 *  - sendMedia: unknown handle rejected; expired handle rejected once the
 *    injected clock passes the 5-minute TTL; a handle is SINGLE-USE; the
 *    TOCTOU window (file swapped for an out-of-root symlink between prepare
 *    and send) fails closed WITHOUT uploading and consumes the handle;
 *  - a scope-denied send does NOT consume the handle (nothing was uploaded).
 */
import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { Api, helpers } from 'telegram';
import type { TelegramClient } from 'telegram';

import {
  AppErrorCode,
  type AppError,
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
import { isOk, type Result } from '../../src/shared/index.js';
import { unwrap } from '../../src/shared/result.js';
import { buildEndpoint } from '../application/_support.js';

const PEER_ID = 101;
const OUT_OF_SCOPE = 999;
/** The adapter's documented upload cap (DEFAULTS.maxMediaBytes). */
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
/** The adapter's documented two-phase handle lifetime (DEFAULTS.mediaHandleTtlMs). */
const MEDIA_HANDLE_TTL_MS = 5 * 60 * 1000;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const tempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

/** A settable time source: starts at a fixed synthetic instant, advances on demand. */
class AdvancingClock implements Clock {
  private ms = Date.parse('2026-01-01T00:00:00.000Z');
  public nowMs(): number {
    return this.ms;
  }
  public nowIso(): string {
    return new Date(this.ms).toISOString();
  }
  public advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

class MediaTelegramClient {
  public connected = true;
  public readonly sendFileCalls: {
    readonly peer: string;
    readonly file: string;
    readonly caption?: string;
  }[] = [];
  public readonly _sender = {
    userDisconnected: false,
    reconnect: (): void => undefined,
    _reconnect: (): Promise<void> => Promise.resolve(),
  };

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
      entity: new Api.User({
        id: helpers.returnBigInt(PEER_ID),
        accessHash: helpers.returnBigInt(0),
        firstName: 'Scoped',
      }),
      inputEntity: new Api.InputPeerUser({
        userId: helpers.returnBigInt(PEER_ID),
        accessHash: helpers.returnBigInt(0),
      }),
      unreadCount: 0,
      pinned: false,
    };
  }

  public sendFile(
    entity: unknown,
    params: { readonly file: string; readonly caption?: string },
  ): Promise<Api.Message> {
    this.sendFileCalls.push({
      peer:
        entity instanceof Api.InputPeerUser
          ? `user:${entity.userId.toString()}`
          : 'unknown',
      file: params.file,
      ...(params.caption !== undefined ? { caption: params.caption } : {}),
    });
    return Promise.resolve(
      new Api.Message({
        id: 77,
        peerId: new Api.PeerUser({ userId: helpers.returnBigInt(PEER_ID) }),
        date: 1_750_000_000,
        message: '',
      }),
    );
  }
}

const setup = async (options?: {
  readonly mediaRootDir?: string;
  readonly clock?: AdvancingClock;
}): Promise<{
  readonly root: string;
  readonly fake: MediaTelegramClient;
  readonly clock: AdvancingClock;
  readonly gateway: GramjsTelegramGateway;
  readonly client: ScopedClient;
  readonly peer: PeerRef;
}> => {
  const root = await tempDir('telegram-mcp-media-root-');
  const fake = new MediaTelegramClient();
  const clock = options?.clock ?? new AdvancingClock();
  const gateway = new GramjsTelegramGateway({
    apiId: 1,
    apiHash: 'test-hash',
    sessionSecret: 'test-session',
    mediaRootDir: options?.mediaRootDir ?? root,
    sanitizer: new UnicodeSanitizer(),
    clock,
    clientFactory: (): TelegramClient => fake as unknown as TelegramClient,
  });
  const id = unwrap(ChatId.create(BigInt(PEER_ID)));
  const bound = await gateway.bindScopedClient({
    endpoint: buildEndpoint({
      verbs: [PermissionVerb.Read, PermissionVerb.Send],
    }),
    resolvedScope: unwrap(ResolvedScope.create([id])),
    overrides: new Map(),
  });
  expect(isOk(bound)).toBe(true);
  if (!isOk(bound)) throw new Error(bound.error.message);
  return { root, fake, clock, gateway, client: bound.value, peer: PeerRefFactory.fromId(id) };
};

/** The ONE anti-oracle rejection shape shared by every out-of-root outcome. */
const expectNotInRoot = (result: Result<unknown, AppError>): void => {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(AppErrorCode.NotFound);
  expect(result.error.message).toBe(
    'media file is not an accessible regular file within the allowed upload directory',
  );
};

describe('prepareMedia — filesystem confinement to the media root', () => {
  it('rejects an existing regular file OUTSIDE the media root', async () => {
    const { gateway, client } = await setup();
    const outside = await tempDir('telegram-mcp-outside-');
    const hostFile = join(outside, 'host-secret.txt');
    await writeFile(hostFile, 'synthetic host content');

    expectNotInRoot(await client.prepareMedia({ localPath: hostFile }));
    await gateway.dispose();
  });

  it('rejects a symlink INSIDE the root that resolves outside it', async () => {
    const { root, gateway, client } = await setup();
    const outside = await tempDir('telegram-mcp-outside-');
    const target = join(outside, 'escape-target.txt');
    await writeFile(target, 'synthetic outside content');
    const link = join(root, 'escape.png');
    await symlink(target, link);

    expectNotInRoot(await client.prepareMedia({ localPath: link }));
    await gateway.dispose();
  });

  it('returns the IDENTICAL error for out-of-root and non-existent paths (no existence oracle)', async () => {
    const { root, gateway, client } = await setup();
    const outside = await tempDir('telegram-mcp-outside-');
    const existingOutside = join(outside, 'exists.txt');
    await writeFile(existingOutside, 'synthetic host content');
    const missing = join(root, 'never-created.txt');

    const outOfRoot = await client.prepareMedia({ localPath: existingOutside });
    const nonExistent = await client.prepareMedia({ localPath: missing });

    expectNotInRoot(outOfRoot);
    expectNotInRoot(nonExistent);
    expect(outOfRoot.ok).toBe(false);
    expect(nonExistent.ok).toBe(false);
    if (!outOfRoot.ok && !nonExistent.ok) {
      // The whole error shape must be indistinguishable, not merely the code.
      expect(outOfRoot.error).toStrictEqual(nonExistent.error);
    }
    await gateway.dispose();
  });

  it('rejects a non-regular file (directory) inside the root', async () => {
    const { root, gateway, client } = await setup();
    const dir = join(root, 'a-directory');
    await mkdir(dir);

    const result = await client.prepareMedia({ localPath: dir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.Validation);
      expect(result.error.message).toBe('media path is not a regular file');
    }
    await gateway.dispose();
  });

  it('rejects a file over the 50 MiB cap by declared size', async () => {
    const { root, gateway, client } = await setup();
    const big = join(root, 'big.bin');
    // Sparse: st_size crosses the cap without writing 50 MiB of real bytes.
    const handle = await open(big, 'w');
    await handle.truncate(MAX_MEDIA_BYTES + 1);
    await handle.close();

    const result = await client.prepareMedia({ localPath: big });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.SizeCapExceeded);
      expect(result.error.message).toContain(String(MAX_MEDIA_BYTES));
    }
    await gateway.dispose();
  });

  it('fails GatewayUnavailable when the configured media root is inaccessible', async () => {
    const missingRoot = join(await tempDir('telegram-mcp-missing-'), 'never-created');
    const { gateway, client } = await setup({ mediaRootDir: missingRoot });

    const result = await client.prepareMedia({ localPath: join(missingRoot, 'a.txt') });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.GatewayUnavailable);
      expect(result.error.message).toBe(
        'configured media root directory is not accessible',
      );
    }
    await gateway.dispose();
  });

  it('mints a handle with size, extension-derived mime, and clock-derived expiry', async () => {
    const { root, gateway, client } = await setup();
    const photo = join(root, 'photo.png');
    await writeFile(photo, 'synthetic png bytes');

    const result = await client.prepareMedia({ localPath: photo });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.sizeBytes).toBe(19);
      expect(result.value.mimeType).toBe('image/png');
      expect(result.value.expiresAtIso).toBe('2026-01-01T00:05:00.000Z');
      expect(result.value.handle.length).toBeGreaterThan(0);
      // Opaque: the handle must not leak the path it confines.
      expect(result.value.handle).not.toContain('photo');
    }
    await gateway.dispose();
  });
});

describe('sendMedia — handle lifecycle and TOCTOU re-confinement', () => {
  const prepared = async (): Promise<{
    readonly root: string;
    readonly fake: MediaTelegramClient;
    readonly clock: AdvancingClock;
    readonly gateway: GramjsTelegramGateway;
    readonly client: ScopedClient;
    readonly peer: PeerRef;
    readonly localPath: string;
    readonly handle: string;
  }> => {
    const context = await setup();
    const localPath = join(context.root, 'photo.png');
    await writeFile(localPath, 'synthetic png bytes');
    const result = await context.client.prepareMedia({ localPath });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) throw new Error(result.error.message);
    return { ...context, localPath, handle: result.value.handle };
  };

  it('uploads the confined real path and consumes the handle (single-use)', async () => {
    const { fake, gateway, client, peer, localPath, handle } = await prepared();

    const first = await client.sendMedia({
      peer,
      handle,
      caption: 'a synthetic caption',
    });

    expect(isOk(first)).toBe(true);
    if (isOk(first)) {
      expect(first.value.chatId).toBe('101');
      expect(first.value.messageId).toBe(77);
      expect(first.value.idempotencyKey.length).toBeGreaterThan(0);
    }
    expect(fake.sendFileCalls).toEqual([
      {
        peer: `user:${String(PEER_ID)}`,
        file: await realpath(localPath),
        caption: 'a synthetic caption',
      },
    ]);

    const second = await client.sendMedia({ peer, handle });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe(AppErrorCode.InvalidMediaHandle);
      expect(second.error.message).toBe('unknown media handle');
    }
    expect(fake.sendFileCalls).toHaveLength(1);
    await gateway.dispose();
  });

  it('rejects an unknown handle without touching the filesystem or Telegram', async () => {
    const { fake, gateway, client, peer } = await setup();

    const result = await client.sendMedia({ peer, handle: 'no-such-handle' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.InvalidMediaHandle);
      expect(result.error.message).toBe('unknown media handle');
    }
    expect(fake.sendFileCalls).toHaveLength(0);
    await gateway.dispose();
  });

  it('rejects a handle once the clock passes the 5-minute TTL', async () => {
    const { fake, clock, gateway, client, peer, handle } = await prepared();

    clock.advance(MEDIA_HANDLE_TTL_MS);
    const result = await client.sendMedia({ peer, handle });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.InvalidMediaHandle);
      expect(result.error.message).toBe('media handle expired');
    }
    expect(fake.sendFileCalls).toHaveLength(0);
    await gateway.dispose();
  });

  it('TOCTOU: a file swapped for an out-of-root symlink between prepare and send fails closed', async () => {
    const { fake, gateway, client, peer, localPath, handle } = await prepared();
    const outside = await tempDir('telegram-mcp-outside-');
    const target = join(outside, 'swapped-in-secret.txt');
    await writeFile(target, 'synthetic outside content');
    // The registered path now resolves OUTSIDE the root.
    await rm(localPath);
    await symlink(target, localPath);

    const result = await client.sendMedia({ peer, handle });

    expectNotInRoot(result);
    expect(fake.sendFileCalls).toHaveLength(0);
    // The compromised handle is consumed, not retryable.
    const retry = await client.sendMedia({ peer, handle });
    expect(retry.ok).toBe(false);
    if (!retry.ok) {
      expect(retry.error.message).toBe('unknown media handle');
    }
    await gateway.dispose();
  });

  it('a scope-denied send neither uploads nor consumes the handle', async () => {
    const { fake, gateway, client, handle, peer } = await prepared();
    const outOfScopePeer = PeerRefFactory.fromId(
      unwrap(ChatId.create(BigInt(OUT_OF_SCOPE))),
    );

    const denied = await client.sendMedia({ peer: outOfScopePeer, handle });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe(AppErrorCode.AclDenied);
      expect(denied.error.message).toContain("outside this endpoint's scope");
    }
    expect(fake.sendFileCalls).toHaveLength(0);

    // The handle survived the denial and still sends in scope.
    const allowed = await client.sendMedia({ peer, handle });
    expect(isOk(allowed)).toBe(true);
    expect(fake.sendFileCalls).toHaveLength(1);
    await gateway.dispose();
  });
});
