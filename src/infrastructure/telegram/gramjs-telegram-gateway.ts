/**
 * The MTProto adapter that mints ScopedClients, and the ONE place an unscoped connection is
 * permitted: scope resolution borrows its narrow dialog-filter capability, then binding returns
 * a client constrained to the endpoint's resolved allow-list. No unscoped client escapes this
 * layer.
 * ONE shared `TelegramClient` per sessionRef, created lazily and reused by every endpoint on
 * the ref: Telegram's auth key must have a single owner-connection per process, so a
 * client-per-endpoint risks AUTH_KEY_DUPLICATED. Scoped clients never destroy the connection —
 * the composition root closes it via `dispose()`.
 */
import { randomBytes } from 'node:crypto';
import type { UnicodeSanitizer } from '../sanitize/unicode-sanitizer.js';
import { createWriteStream, type WriteStream } from 'node:fs';
import { chmod, mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { finished } from 'node:stream/promises';
import { Api, TelegramClient, helpers, sessions } from 'telegram';

import { silentGramjsLogger } from './gramjs-logger.js';
import { GramjsSenderLifecycle } from './gramjs-sender-lifecycle.js';
import { mapGramjsError } from './gramjs-errors.js';
import { SECRET_MODES } from '../fs-permissions.js';

import type {
  BindScopedClientInput,
  AccountSnapshotDto,
  ScopedClient,
  Clock,
  AppError,
  Page,
  MessageDto,
  DialogDto,
  ChatInfoDto,
  ParticipantDto,
  TopicDto,
  MediaInfoDto,
  MediaFileDto,
  SendResultDto,
  EditResultDto,
  DeleteResultDto,
  DraftResultDto,
  MarkReadResultDto,
  ForwardResultDto,
  ReactionResultDto,
  MediaHandleDto,
  GetMessagesQuery,
  SearchMessagesQuery,
  ListDialogsQuery,
  ListTopicsQuery,
  GetChatInfoQuery,
  GetMediaInfoQuery,
  DownloadMediaQuery,
  GetPinnedQuery,
  ListParticipantsQuery,
  SendMessageCommand,
  EditMessageCommand,
  DeleteMessageCommand,
  SaveDraftCommand,
  MarkReadCommand,
  ForwardMessageCommand,
  SendReactionCommand,
  PrepareMediaCommand,
  SendMediaCommand,
} from '../../application/index.js';
import {
  AppErrorCode,
  MAX_SEARCH_FANOUT_CALLS,
  appError,
} from '../../application/index.js';
import type {
  ResolvedScope,
  PeerRef,
  SessionRefValue,
  UntrustedText,
  ChatVerbOverrideTable,
} from '../../domain/index.js';
import {
  ChatId,
  PermissionVerb,
  chatOverridePermitsVerb,
} from '../../domain/index.js';
import type { Result } from '../../shared/index.js';
import { ok, err } from '../../shared/index.js';
import {
  canonicalIdOf,
  displayNameOf,
  isForumOf,
  isResolvedEntity,
  mapChatInfo,
  mapDialog,
  mapMediaInfo,
  mapMessage,
  mapParticipant,
  mapTopic,
  topicReplyParams,
  unixToIso,
  usernameOf,
  type ResolvedEntity,
} from './gramjs-mappers.js';
import type {
  DialogFilterClient,
  DialogFilterClientProvider,
} from './DialogFilterFolderResolver.js';
import { readAccountSnapshot } from './gramjs-account-reader.js';

const DEFAULTS = {
  // Below this GramJS auto-sleeps; at or above it the wait surfaces as `AppError(FloodWait)` so
  // the rate limiter and the model can react.
  floodSleepThresholdSeconds: 10,
  connectionRetries: 5,
  // Hard cap on a single media file accepted by prepareMedia.
  maxMediaBytes: 50 * 1024 * 1024,
  // Operator disk guard, not a security boundary; the config's `maxDownloadBytes` overrides it.
  maxDownloadBytes: 50 * 1024 * 1024,
  maxPageItems: 100,
  mediaHandleTtlMs: 5 * 60 * 1000,
} as const;

// Bounds the in-memory handle map against a flood of `prepare_media`.
const MAX_LIVE_MEDIA_HANDLES = 64;
// Best-effort idempotency replay cache; oldest evicted first.
const MAX_IDEMPOTENCY_KEYS = 1024;

// Composition-root seam; names a GramJS type — see ARCHITECTURE.md, constraint 3.
export type TelegramClientFactory = (sessionRef: string) => TelegramClient;

export interface GramjsTelegramGatewayOptions {
  readonly apiId: number;
  readonly apiHash: string;
  // The gateway never touches session persistence or key material — only this plaintext crosses
  // in.
  readonly sessionSecret: string;
  /**
   * REQUIRED allow-listed upload directory: a local path is accepted only if its canonicalized
   * realpath resolves INSIDE it, symlinks included. Without it a `send`-capable endpoint could
   * upload any readable file — session keyfile, SSH keys, /etc/passwd.
   */
  readonly mediaRootDir: string;
  // Untrusted-content chokepoint; wraps every Telegram string at the edge.
  readonly sanitizer: UnicodeSanitizer;
  readonly clock: Clock;
  // Non-secret diagnostics only; never receives session material.
  readonly logger?: (message: string) => void;
  readonly clientFactory?: TelegramClientFactory;
}

interface ScopeBinding {
  // Canonical-id key -> input handle: the ONLY way to address a peer.
  readonly inputPeers: ReadonlyMap<string, Api.TypeInputPeer>;
  readonly entities: ReadonlyMap<string, ResolvedEntity>;
  readonly displayNames: ReadonlyMap<string, UntrustedText>;
  readonly usernameIndex: ReadonlyMap<string, string>;
  readonly orderedPeers: readonly {
    readonly key: string;
    readonly inputPeer: Api.TypeInputPeer;
  }[];
}

interface MediaHandleEntry {
  readonly localPath: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly expiresAtMs: number;
}

interface ResolvedPeer {
  readonly inputPeer: Api.TypeInputPeer;
  readonly chatId: ChatId;
  readonly canonicalId: string;
}

interface MessageSearchBatch {
  readonly items: readonly MessageDto[];
  readonly nextOffsetId?: number;
}

interface ScopedClientDeps {
  readonly client: TelegramClient;
  readonly ensureConnected: () => Promise<Result<void, AppError>>;
  readonly resolvedScope: ResolvedScope;
  readonly overrides: ChatVerbOverrideTable;
  readonly selfId: bigint;
  readonly binding: ScopeBinding;
  readonly sanitizer: UnicodeSanitizer;
  readonly clock: Clock;
  readonly maxDownloadBytes: number;
  readonly mediaRootDir: string;
}

// Not Telegram's `random_id` — this drives only the best-effort in-memory replay cache, never
// server-side de-duplication.
const mintIdempotencyKey = (): string =>
  BigInt(`0x${randomBytes(8).toString('hex')}`).toString();

// An opaque, unguessable media handle (carries no path information).
const mintHandle = (): string => randomBytes(24).toString('base64url');

const encodeCursor = (offsetId: number): string =>
  Buffer.from(String(offsetId), 'utf8').toString('base64url');

const decodeCursor = (cursor: string): number | undefined => {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

type SearchCursor =
  | { readonly kind: 'peer'; readonly offsetId: number }
  | {
      readonly kind: 'scope';
      readonly peerIndex: number;
      readonly offsetId: number;
    };

const encodePeerSearchCursor = (offsetId: number): string =>
  Buffer.from(`p:${String(offsetId)}`, 'utf8').toString('base64url');

const encodeScopeSearchCursor = (
  peerIndex: number,
  offsetId: number,
): string =>
  Buffer.from(`s:${String(peerIndex)}:${String(offsetId)}`, 'utf8').toString(
    'base64url',
  );

const decodeSearchCursor = (cursor: string): SearchCursor | undefined => {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const peer = /^p:([1-9]\d*)$/.exec(raw);
  if (peer !== null) {
    const offsetId = Number(peer[1]);
    return Number.isSafeInteger(offsetId) ? { kind: 'peer', offsetId } : undefined;
  }
  const scope = /^s:(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(raw);
  if (scope === null) return undefined;
  const peerIndex = Number(scope[1]);
  const offsetId = Number(scope[2]);
  return Number.isSafeInteger(peerIndex) && Number.isSafeInteger(offsetId)
    ? { kind: 'scope', peerIndex, offsetId }
    : undefined;
};

const encodeDialogCursor = (offset: number): string =>
  Buffer.from(`d:${String(offset)}`, 'utf8').toString('base64url');

const decodeDialogCursor = (cursor: string): number | undefined => {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^d:([1-9]\d*)$/.exec(raw);
  if (match === null) return undefined;
  const offset = Number(match[1]);
  return Number.isSafeInteger(offset) ? offset : undefined;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.trunc(value)));

const MIME_BY_EXT: ReadonlyMap<string, string> = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.mp4', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.zip', 'application/zip'],
]);

const guessMime = (path: string): string =>
  MIME_BY_EXT.get(extname(path).toLowerCase()) ?? 'application/octet-stream';

// Keeps only `[A-Za-z0-9._-]`, drops leading dots (no hidden files, no `..`) and caps the
// length; empty when nothing survives.
const sanitizeFsNameComponent = (raw: string): string =>
  raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 64);

// Server-generated `<chatIdKey>_<messageId>_<name>`. Every component is sanitized, so the
// result can carry no path separator or `..` — and the caller supplies none of it.
export const downloadBasename = (
  chatKey: string,
  messageId: number,
  info: MediaFileNameSource,
): string => {
  const original = info.fileName?.sanitizedValue;
  const named = original !== undefined ? sanitizeFsNameComponent(original) : '';
  const namePart = named.length > 0 ? named : info.kind;
  const keyPart = chatKey.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${keyPart}_${String(messageId)}_${namePart}`;
};

interface MediaFileNameSource {
  readonly kind: string;
  readonly fileName?: { readonly sanitizedValue: string };
}

// A resource guard for the operator's disk, not a security boundary. An undefined declared size
// (a photo carries none) cannot be pre-checked, so it passes.
export const overDownloadCap = (
  declaredSize: number | undefined,
  cap: number,
): AppError | undefined =>
  declaredSize !== undefined && declaredSize > cap
    ? appError(
        AppErrorCode.SizeCapExceeded,
        `media declares ${String(declaredSize)} bytes, exceeding the ${String(cap)}-byte download cap`,
      )
    : undefined;

// Private sentinel thrown from GramJS's progress callback to stop the iterator.
const DOWNLOAD_CAP_ABORT = new Error('download cap reached');

const downloadCapExceeded = (cap: number): AppError =>
  appError(
    AppErrorCode.SizeCapExceeded,
    `media exceeded the ${String(cap)}-byte download cap`,
  );

/**
 * GramJS treats `WriteStream.write()` as awaitable and then calls `close()` without awaiting
 * it. Keep the quirk at this boundary: await backpressure per write and expose the close
 * barrier the publisher must cross.
 */
const openDownloadWriter = (
  filePath: string,
): { readonly output: WriteStream; readonly closed: Promise<void> } => {
  const output = createWriteStream(filePath, {
    flags: 'wx',
    mode: SECRET_MODES.file,
  });
  const write = output.write.bind(output);
  output.write = ((chunk: Uint8Array): Promise<boolean> =>
    new Promise<boolean>((resolve, reject) => {
      write(chunk, (error) => {
        if (error != null) reject(error);
        else resolve(true);
      });
    })) as unknown as WriteStream['write'];
  const closed = finished(output);
  void closed.catch(() => undefined);
  return { output, closed };
};

export class GramjsTelegramGateway implements DialogFilterClientProvider {
  public constructor(private readonly options: GramjsTelegramGatewayOptions) {}

  // One connected client per sessionRef, lazily created and memoized. Concurrent binds share
  // the in-flight promise; a failed attempt is not cached, so a later bind can retry.
  private shared: { readonly client: TelegramClient; readonly selfId: bigint } | undefined;
  private sharedPromise:
    | Promise<Result<{ client: TelegramClient; selfId: bigint }, AppError>>
    | undefined;
  private disposed = false;
  // One shared teardown: a caller's promise resolving MUST mean the connection is actually gone
  // (the auth-key ownership contract), so every caller awaits the same promise.
  private disposing: Promise<void> | undefined;
  // ONE reconnect attempt for the shared client. Scoped clients and GramJS's
  // sender callbacks both enter through this promise, and dispose() awaits it.
  private reconnecting: Promise<Result<void, AppError>> | undefined;
  // Gateway-level loans (scope resolution and scoped-client binding) are
  // drained before the physical connection is destroyed.
  private readonly activeUses = new Set<Promise<unknown>>();
  // Route every GramJS sender through this gateway's one reconnect controller,
  // and neutralize queued reconnects synchronously during disposal.
  private readonly senders = new GramjsSenderLifecycle(
    (client): Promise<void> =>
      this.startReconnect(client, true).then(() => undefined),
  );
  // So dispose() can refuse and drain their operations before destroying the shared connection.
  private readonly scopedClients = new Set<GramjsScopedClient>();

  public bindScopedClient(
    input: BindScopedClientInput,
  ): Promise<Result<ScopedClient, AppError>> {
    if (this.disposed) {
      return Promise.resolve(
        err(appError(AppErrorCode.GatewayUnavailable, 'gateway was disposed')),
      );
    }
    return this.trackUse(this.bindScopedClientLive(input));
  }

  public releaseScopedClient(client: ScopedClient): Promise<void> {
    if (!(client instanceof GramjsScopedClient)) return Promise.resolve();
    this.scopedClients.delete(client);
    return client.dispose();
  }

  private async bindScopedClientLive(
    input: BindScopedClientInput,
  ): Promise<Result<ScopedClient, AppError>> {
    const { endpoint, resolvedScope, overrides } = input;

    const conn = await this.connectShared(endpoint.sessionRef);
    if (!conn.ok) {
      return err(conn.error);
    }
    const { client, selfId } = conn.value;

    try {
      const binding = await this.buildBinding(client, resolvedScope);
      if (binding.inputPeers.size === 0) {
        // Per-endpoint resolution failure — never tear down the SHARED client.
        return err(
          appError(
            AppErrorCode.GatewayUnavailable,
            `no in-scope peers could be resolved for endpoint '${endpoint.name}'`,
          ),
        );
      }

      const scoped = new GramjsScopedClient({
        client,
        ensureConnected: (): Promise<Result<void, AppError>> =>
          this.ensureSharedConnected(client),
        resolvedScope,
        overrides,
        selfId,
        binding,
        sanitizer: this.options.sanitizer,
        clock: this.options.clock,
        maxDownloadBytes: input.maxDownloadBytes ?? DEFAULTS.maxDownloadBytes,
        mediaRootDir: this.options.mediaRootDir,
      });
      this.scopedClients.add(scoped);
      if (this.isDisposed()) {
        // dispose() swept the registry before this add landed, so retire the straggler here —
        // it must never reconnect the destroyed shared client.
        this.scopedClients.delete(scoped);
        await scoped.dispose();
        return err(
          appError(AppErrorCode.GatewayUnavailable, 'gateway was disposed'),
        );
      }
      return ok(scoped);
    } catch (error) {
      // Per-endpoint bind failure — the shared client stays up for others.
      return err(mapGramjsError(error));
    }
  }

  public withClient<T>(
    sessionRef: SessionRefValue,
    use: (client: DialogFilterClient) => Promise<Result<T, AppError>>,
  ): Promise<Result<T, AppError>> {
    return this.loanClient(sessionRef, use);
  }

  public snapshotAccount(
    sessionRef: SessionRefValue,
  ): Promise<Result<AccountSnapshotDto, AppError>> {
    return this.loanClient(sessionRef, (client) =>
      readAccountSnapshot(client, this.options.sanitizer),
    );
  }

  private loanClient<T>(
    sessionRef: SessionRefValue,
    use: (client: TelegramClient) => Promise<Result<T, AppError>>,
  ): Promise<Result<T, AppError>> {
    if (this.disposed) {
      return Promise.resolve(
        err(appError(AppErrorCode.GatewayUnavailable, 'gateway was disposed')),
      );
    }
    return this.trackUse(this.withSharedClient(sessionRef, use));
  }

  private async withSharedClient<T>(
    sessionRef: SessionRefValue,
    use: (client: TelegramClient) => Promise<Result<T, AppError>>,
  ): Promise<Result<T, AppError>> {
    const connected = await this.connectShared(String(sessionRef));
    if (!connected.ok) {
      return connected;
    }
    try {
      return await use(connected.value.client);
    } catch (error) {
      return err(mapGramjsError(error));
    }
  }

  /**
   * Idempotent, composition-root owned, and a complete ownership barrier: once it resolves,
   * this gateway can never own a Telegram connection again.
   * Scoped clients retire FIRST, so an in-flight handler's next op is refused instead of lazily
   * reconnecting the destroyed client and resurrecting this auth key alongside its replacement.
   * An in-flight `openShared` is awaited to completion — resolving mid-connect would declare
   * the key free just as the old connection comes up.
   */
  public dispose(): Promise<void> {
    /**
     * The first caller owns the teardown and every later one awaits the same promise.
     * `disposed` flips synchronously, so in-flight scoped ops observe the retirement
     * immediately.
     */
    this.disposed = true;
    this.senders.quiesce();
    this.disposing ??= this.teardown();
    return this.disposing;
  }

  private async teardown(): Promise<void> {
    await Promise.all(
      [...this.scopedClients].map((scoped) => scoped.dispose()),
    );
    this.scopedClients.clear();

    // Binds and resolver loans may still be using the unscoped client. Once
    // disposed is true no new loan can enter, so this snapshot is complete.
    await Promise.allSettled([...this.activeUses]);

    const reconnecting = this.reconnecting;
    if (reconnecting !== undefined) {
      await reconnecting;
    }
    const pending = this.sharedPromise;
    if (pending !== undefined) {
      // A rejected open means its mandatory cleanup failed. Propagate it: the
      // caller cannot safely hand this auth key to another generation.
      await pending;
    }
    const client = this.shared?.client;
    if (client !== undefined) {
      this.senders.quiesce();
      await client.destroy(); // ownership is uncertain if this rejects
      this.senders.releaseClient(client);
      this.shared = undefined;
      this.sharedPromise = undefined;
    }
  }

  private async connectShared(
    sessionRef: string,
  ): Promise<Result<{ client: TelegramClient; selfId: bigint }, AppError>> {
    if (this.disposed) {
      return err(
        appError(AppErrorCode.GatewayUnavailable, 'gateway was disposed'),
      );
    }
    if (this.shared !== undefined) {
      const ready = await this.ensureSharedConnected(this.shared.client);
      if (!ready.ok) {
        return ready;
      }
      return ok(this.shared);
    }
    const pending = (this.sharedPromise ??= this.openShared(sessionRef));
    let res: Result<{ client: TelegramClient; selfId: bigint }, AppError>;
    try {
      res = await pending;
    } catch (error) {
      // openShared rejects only when it could not prove an aborted client was destroyed. Keep
      // that rejected promise cached so dispose() stays a fail-closed ownership barrier.
      return err(mapGramjsError(error));
    }
    if (!res.ok) {
      if (this.sharedPromise === pending) {
        this.sharedPromise = undefined; // ordinary failures may be retried
      }
    }
    return res;
  }

  private async openShared(
    sessionRef: string,
  ): Promise<Result<{ client: TelegramClient; selfId: bigint }, AppError>> {
    /**
     * Construction is inside the try: `new StringSession(secret)` throws on a corrupt session
     * string. Ordinary failures resolve to a Result; failing to destroy an aborted client
     * rejects and poisons this barrier.
     */
    let client: TelegramClient | undefined;
    let destroyAttempted = false;
    try {
      client =
        this.options.clientFactory?.(sessionRef) ??
        new TelegramClient(
          new sessions.StringSession(this.options.sessionSecret),
          this.options.apiId,
          this.options.apiHash,
          {
            connectionRetries: DEFAULTS.connectionRetries,
            floodSleepThreshold: DEFAULTS.floodSleepThresholdSeconds,
            // GramJS 2.26.x does not consistently consult this option. The
            // sender hooks installed below are the actual ownership boundary.
            autoReconnect: false,
            baseLogger: silentGramjsLogger(),
          },
        );
      await client.connect();
      this.senders.track(client);
      if (!(await client.isUserAuthorized())) {
        destroyAttempted = true;
        await this.destroyAbortedClient(client);
        return err(
          appError(
            AppErrorCode.GatewayUnavailable,
            `session '${sessionRef}' is not authorized; run setup`,
          ),
        );
      }
      const me = await client.getMe();
      const selfId = canonicalIdOf(me);
      if (this.disposed) {
        // A dispose() raced the connect — do not leak the client.
        destroyAttempted = true;
        await this.destroyAbortedClient(client);
        return err(
          appError(AppErrorCode.GatewayUnavailable, 'gateway was disposed'),
        );
      }
      this.shared = { client, selfId };
      return ok(this.shared);
    } catch (error) {
      if (destroyAttempted) {
        throw error;
      }
      if (client !== undefined) {
        try {
          await this.destroyAbortedClient(client);
        } catch (destroyError) {
          throw destroyError instanceof Error
            ? destroyError
            : new Error('aborted Telegram client could not be destroyed');
        }
      }
      return err(mapGramjsError(error));
    }
  }

  private ensureSharedConnected(
    client: TelegramClient,
  ): Promise<Result<void, AppError>> {
    if (this.disposed) {
      return Promise.resolve(
        err(appError(AppErrorCode.GatewayUnavailable, 'gateway was disposed')),
      );
    }
    if (client.connected === true) {
      return Promise.resolve(ok(undefined));
    }
    return this.startReconnect(client, false);
  }

  private startReconnect(
    client: TelegramClient,
    disconnectFirst: boolean,
  ): Promise<Result<void, AppError>> {
    const existing = this.reconnecting;
    if (existing !== undefined) {
      return existing;
    }
    const reconnecting = this.reconnectShared(client, disconnectFirst);
    this.reconnecting = reconnecting;
    void reconnecting.then(() => {
      if (this.reconnecting === reconnecting) {
        this.reconnecting = undefined;
      }
    });
    return reconnecting;
  }

  private async reconnectShared(
    client: TelegramClient,
    disconnectFirst: boolean,
  ): Promise<Result<void, AppError>> {
    try {
      if (disconnectFirst) {
        await client.disconnect();
      }
      if (this.disposed) {
        return err(appError(AppErrorCode.GatewayUnavailable, 'gateway was disposed'));
      }
      await client.connect();
      this.senders.track(client);
      if (this.isDisposed()) {
        return err(appError(AppErrorCode.GatewayUnavailable, 'gateway was disposed'));
      }
      return ok(undefined);
    } catch (error) {
      return err(mapGramjsError(error));
    }
  }

  private async destroyAbortedClient(client: TelegramClient): Promise<void> {
    this.senders.track(client);
    this.senders.quiesceClient(client);
    await client.destroy();
    this.senders.releaseClient(client);
  }

  private trackUse<T>(use: Promise<T>): Promise<T> {
    this.activeUses.add(use);
    void use.then(
      () => this.activeUses.delete(use),
      () => this.activeUses.delete(use),
    );
    return use;
  }

  // Read through a method so TypeScript does not retain a pre-await narrowing.
  private isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Peers outside the resolved scope are dropped, and in-scope peers that are not addressable
   * never enter the cache — so they stay unfetchable. FAIL-CLOSED: the caller rejects an empty
   * result.
   */
  private async buildBinding(
    client: TelegramClient,
    scope: ResolvedScope,
  ): Promise<ScopeBinding> {
    const inputPeers = new Map<string, Api.TypeInputPeer>();
    const entities = new Map<string, ResolvedEntity>();
    const displayNames = new Map<string, UntrustedText>();
    const usernameIndex = new Map<string, string>();
    const orderedPeers: {
      readonly key: string;
      readonly inputPeer: Api.TypeInputPeer;
    }[] = [];

    for await (const dialog of client.iterDialogs({})) {
      const entity = dialog.entity;
      if (!isResolvedEntity(entity)) {
        continue;
      }
      let marked: bigint;
      try {
        marked = canonicalIdOf(entity);
      } catch {
        continue;
      }
      const idRes = ChatId.create(marked);
      if (!idRes.ok || !scope.contains(idRes.value)) {
        continue;
      }
      const key = idRes.value.toKey();
      if (inputPeers.has(key)) {
        continue;
      }
      inputPeers.set(key, dialog.inputEntity);
      entities.set(key, entity);
      displayNames.set(key, displayNameOf(entity, this.options.sanitizer));
      orderedPeers.push({
        key,
        inputPeer: dialog.inputEntity,
      });
      const uname = usernameOf(entity);
      if (uname !== undefined) {
        usernameIndex.set(uname.toLowerCase(), key);
      }
      if (inputPeers.size === scope.size) break;
    }

    this.options.logger?.(
      `scope binding resolved ${String(inputPeers.size)}/${String(scope.size)} peers`,
    );
    return {
      inputPeers,
      entities,
      displayNames,
      usernameIndex,
      orderedPeers: Object.freeze(orderedPeers),
    };
  }
}

class GramjsScopedClient implements ScopedClient {
  private readonly client: TelegramClient;
  private readonly ensureGatewayConnected: () => Promise<Result<void, AppError>>;
  private readonly scope: ResolvedScope;
  private readonly selfId: bigint;
  private readonly overrides: ChatVerbOverrideTable;
  private readonly binding: ScopeBinding;
  private readonly sanitizer: UnicodeSanitizer;
  private readonly clock: Clock;
  private readonly maxDownloadBytes: number;
  private readonly mediaRootDir: string;
  private readonly dialogPeers: ScopeBinding['orderedPeers'];

  private disposed = false;
  private disposing: Promise<void> | undefined;
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly mediaHandles = new Map<string, MediaHandleEntry>();
  private pendingMediaPreparations = 0;
  /**
   * BEST-EFFORT send de-duplication, not exactly-once: a key is remembered only after an
   * observed success, so it does not cover an ambiguous failure, a restart or policy change
   * (in-memory, per instance), or server-side dedup — the key is never sent as Telegram's
   * `random_id`.
   */
  private readonly idempotency = new Map<string, SendResultDto>();

  public constructor(deps: ScopedClientDeps) {
    this.client = deps.client;
    this.ensureGatewayConnected = deps.ensureConnected;
    this.scope = deps.resolvedScope;
    this.selfId = deps.selfId;
    this.overrides = deps.overrides;
    this.binding = deps.binding;
    this.sanitizer = deps.sanitizer;
    this.clock = deps.clock;
    this.maxDownloadBytes = deps.maxDownloadBytes;
    this.mediaRootDir = deps.mediaRootDir;
    const dialogPeers: ScopeBinding['orderedPeers'][number][] = [];
    for (const peer of deps.binding.orderedPeers) {
      if (
        chatOverridePermitsVerb({
          key: peer.key,
          verb: PermissionVerb.Read,
          overrides: deps.overrides,
        })
      ) {
        dialogPeers.push(peer);
      }
    }
    this.dialogPeers = Object.freeze(dialogPeers);
  }

  public resolvePeer(peer: PeerRef): Promise<Result<ChatId, AppError>> {
    const resolved = this.resolvePeerUnchecked(peer);
    return Promise.resolve(
      resolved.ok ? ok(resolved.value.chatId) : err(resolved.error),
    );
  }

  public getMessages(
    q: GetMessagesQuery,
  ): Promise<Result<Page<MessageDto>, AppError>> {
    return this.withPeer(q.peer, PermissionVerb.Read, async (resolved) => {
      // A topicId is only meaningful for a forum supergroup; requiring it here stops GetReplies
      // from pivoting a broadcast channel onto its out-of-scope linked discussion group.
      if (q.topicId !== undefined) {
        const forum = this.requireForumPeer(resolved);
        if (!forum.ok) {
          return forum;
        }
      }

      const limit = clamp(q.limit, 1, DEFAULTS.maxPageItems);
      let offsetId: number | undefined;
      if (q.cursor !== undefined) {
        offsetId = decodeCursor(q.cursor);
        if (offsetId === undefined) {
          return err(appError(AppErrorCode.Validation, 'invalid pagination cursor'));
        }
      }

      // A topicId switches GramJS to messages.GetReplies; the forum pre-check above keeps this
      // same-peer, so the thread cannot resolve to another chat.
      const list = await this.client.getMessages(resolved.inputPeer, {
        limit,
        ...(offsetId !== undefined ? { offsetId } : {}),
        ...(q.topicId !== undefined ? { replyTo: q.topicId } : {}),
      });
      const items = list
        .filter((m): m is Api.Message => m instanceof Api.Message)
        .map((m) => this.toMessageDto(m));
      const oldest = list.length > 0 ? list[list.length - 1] : undefined;
      const nextCursor =
        list.length >= limit && oldest !== undefined
          ? encodeCursor(oldest.id)
          : undefined;
      return ok({
        items,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      });
    });
  }

  public searchMessages(
    q: SearchMessagesQuery,
  ): Promise<Result<Page<MessageDto>, AppError>> {
    return this.withConnection(() => this.searchMessagesConnected(q));
  }

  private async searchMessagesConnected(
    q: SearchMessagesQuery,
  ): Promise<Result<Page<MessageDto>, AppError>> {
    const limit = clamp(q.limit, 1, DEFAULTS.maxPageItems);

    if (q.peer !== undefined) {
      const resolved = this.resolvePeerForVerb(q.peer, PermissionVerb.Read);
      if (!resolved.ok) {
        return resolved;
      }
      let offsetId: number | undefined;
      if (q.cursor !== undefined) {
        const cursor = decodeSearchCursor(q.cursor);
        if (cursor?.kind !== 'peer') {
          return err(appError(AppErrorCode.Validation, 'invalid search cursor'));
        }
        offsetId = cursor.offsetId;
      }
      if (q.topicId !== undefined) {
        const forum = this.requireForumPeer(resolved.value);
        if (!forum.ok) return forum;
      }
      const batch = await this.invokeScopedSearch(resolved.value.inputPeer, limit, {
        q: q.query,
        ...(q.topicId !== undefined ? { topMsgId: q.topicId } : {}),
        ...(offsetId !== undefined ? { offsetId } : {}),
      });
      return batch.ok ? ok(this.toPeerSearchPage(batch.value)) : batch;
    }

    // A topic filter without a peer is contradictory; the schema rejects it, and this re-check
    // keeps the data layer fail-closed on its own.
    if (q.topicId !== undefined) {
      return err(
        appError(
          AppErrorCode.Validation,
          'topicId requires peer: a forum topic is scoped to a single chat',
        ),
      );
    }

    let peerIndex = 0;
    let offsetId = 0;
    if (q.cursor !== undefined) {
      const cursor = decodeSearchCursor(q.cursor);
      if (
        cursor?.kind !== 'scope' ||
        cursor.peerIndex >= this.binding.orderedPeers.length
      ) {
        return err(appError(AppErrorCode.Validation, 'invalid search cursor'));
      }
      peerIndex = cursor.peerIndex;
      offsetId = cursor.offsetId;
    }

    /**
     * Whole-scope fan-out is deliberately sequential and call-bounded: a page visits at most
     * MAX_SEARCH_FANOUT_CALLS searches, then returns a composite cursor carrying only an array
     * offset and a message offset — never a peer id or access hash.
     */
    const collected: MessageDto[] = [];
    let calls = 0;
    while (
      peerIndex < this.binding.orderedPeers.length &&
      collected.length < limit &&
      calls < MAX_SEARCH_FANOUT_CALLS
    ) {
      const peer = this.binding.orderedPeers[peerIndex];
      if (peer === undefined) break;
      if (
        !chatOverridePermitsVerb({
          key: peer.key,
          verb: PermissionVerb.Read,
          overrides: this.overrides,
        })
      ) {
        peerIndex += 1;
        offsetId = 0;
        continue;
      }
      const remaining = limit - collected.length;
      calls += 1;
      const res = await this.invokeScopedSearch(peer.inputPeer, remaining, {
        q: q.query,
        ...(offsetId > 0 ? { offsetId } : {}),
      });
      if (!res.ok) {
        // A successful page cannot honestly advance past a peer whose search failed: that turns
        // a transient outage into silent, unrecoverable result loss for the continuation chain.
        return res;
      }
      collected.push(...res.value.items);
      if (res.value.nextOffsetId !== undefined) {
        offsetId = res.value.nextOffsetId;
      } else {
        peerIndex += 1;
        offsetId = 0;
      }
    }
    const nextCursor =
      peerIndex < this.binding.orderedPeers.length
        ? encodeScopeSearchCursor(peerIndex, offsetId)
        : undefined;
    return ok({
      items: collected.slice(0, limit),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    });
  }

  public listDialogs(
    q: ListDialogsQuery,
  ): Promise<Result<Page<DialogDto>, AppError>> {
    return this.withConnection<Page<DialogDto>>(async () => {
      const limit = clamp(q.limit, 1, DEFAULTS.maxPageItems);
      let offset = 0;
      if (q.cursor !== undefined) {
        const decoded = decodeDialogCursor(q.cursor);
        if (decoded === undefined || decoded > this.dialogPeers.length) {
          return err(appError(AppErrorCode.Validation, 'invalid dialog cursor'));
        }
        offset = decoded;
      }

      const end = Math.min(offset + limit, this.dialogPeers.length);
      const pagePeers = this.dialogPeers.slice(offset, end);
      if (pagePeers.length === 0) {
        return ok({ items: [] });
      }

      const fresh = await this.client.invoke(
        new Api.messages.GetPeerDialogs({
          peers: pagePeers.map(
            ({ inputPeer }) => new Api.InputDialogPeer({ peer: inputPeer }),
          ),
        }),
      );
      const freshEntities = new Map<string, ResolvedEntity>();
      for (const entity of [...fresh.users, ...fresh.chats]) {
        if (!isResolvedEntity(entity)) continue;
        try {
          freshEntities.set(canonicalIdOf(entity).toString(), entity);
        } catch {
          // Fail closed below if Telegram returned an invalid entity.
        }
      }
      const freshDialogs = new Map<string, Api.Dialog>();
      for (const dialog of fresh.dialogs) {
        if (!(dialog instanceof Api.Dialog)) continue;
        try {
          freshDialogs.set(canonicalIdOf(dialog.peer).toString(), dialog);
        } catch {
          // Fail closed below if Telegram returned an invalid peer.
        }
      }

      const items: DialogDto[] = [];
      for (const peer of pagePeers) {
        const dialog = freshDialogs.get(peer.key);
        const entity = freshEntities.get(peer.key) ?? this.binding.entities.get(peer.key);
        if (dialog === undefined || entity === undefined) continue;
        items.push(
          mapDialog(
            {
              entity,
              unreadCount: dialog.unreadCount,
              pinned: dialog.pinned === true,
            },
            this.sanitizer,
          ),
        );
      }
      return ok({
        items,
        ...(end < this.dialogPeers.length
          ? { nextCursor: encodeDialogCursor(end) }
          : {}),
      });
    });
  }

  public listTopics(
    q: ListTopicsQuery,
  ): Promise<Result<Page<TopicDto>, AppError>> {
    return this.withPeer(q.peer, PermissionVerb.Read, async (resolved) => {
      // Pre-check the scoped entity cache: fail fast on a non-forum instead of
      // surfacing CHANNEL_FORUM_MISSING after a round-trip.
      const forum = this.requireForumPeer(resolved);
      if (!forum.ok) {
        return forum;
      }
      const limit = clamp(q.limit, 1, DEFAULTS.maxPageItems);
      // Single page, most-recently-active first; a forum with more topics than
      // the cap returns the first `limit` of them.
      const result = await this.client.invoke(
        new Api.channels.GetForumTopics({
          channel: resolved.inputPeer,
          offsetDate: 0,
          offsetId: 0,
          offsetTopic: 0,
          limit,
        }),
      );
      const items = result.topics
        .filter((t): t is Api.ForumTopic => t instanceof Api.ForumTopic)
        .slice(0, limit)
        .map((t) => mapTopic(t, this.sanitizer));
      return ok({ items });
    });
  }

  public getChatInfo(
    q: GetChatInfoQuery,
  ): Promise<Result<ChatInfoDto, AppError>> {
    // Entity-cache only (no network round-trip), so this stays synchronous
    // internally while still satisfying the async ScopedClient contract.
    const live = this.ensureLive();
    if (!live.ok) {
      return Promise.resolve(live);
    }
    const resolved = this.resolvePeerForVerb(q.peer, PermissionVerb.Read);
    if (!resolved.ok) {
      return Promise.resolve(resolved);
    }
    const entity = this.binding.entities.get(resolved.value.canonicalId);
    if (entity === undefined) {
      return Promise.resolve(
        err(
          appError(AppErrorCode.NotFound, 'chat info unavailable for that peer'),
        ),
      );
    }
    return Promise.resolve(ok(mapChatInfo(entity, this.sanitizer)));
  }

  public getMediaInfo(
    q: GetMediaInfoQuery,
  ): Promise<Result<MediaInfoDto, AppError>> {
    return this.withPeer(q.peer, PermissionVerb.Read, async (resolved) => {
      const fetched = await this.fetchMediaInfo(resolved, q.messageId, {
        code: AppErrorCode.NotFound,
        message: `message ${String(q.messageId)} has no media`,
      });
      return fetched.ok ? ok(fetched.value.info) : fetched;
    });
  }

  public downloadMedia(
    q: DownloadMediaQuery,
  ): Promise<Result<MediaFileDto, AppError>> {
    // Media EGRESS is its OWN verb: gate on read_media (per-chat override honored),
    // distinct from plain `read` — a text-only endpoint has read but not read_media.
    return this.withPeer(q.peer, PermissionVerb.ReadMedia, async (resolved) => {
      const fetched = await this.fetchMediaInfo(resolved, q.messageId, {
        code: AppErrorCode.Validation,
        message: `message ${String(q.messageId)} has no media to download`,
      });
      if (!fetched.ok) {
        return fetched;
      }
      const { message, info } = fetched.value;
      // Enforce the declared size cap BEFORE downloading a byte; unknown or dishonest sizes
      // stay bounded by the progress and post-write checks below.
      const capError = overDownloadCap(info.sizeBytes, this.maxDownloadBytes);
      if (capError !== undefined) {
        return err(capError);
      }
      // Server-generated, confined path `<mediaRoot>/downloads/…`: the caller supplies none of
      // it, so no traversal is possible, and dir and file are owner-only.
      const dir = join(this.mediaRootDir, 'downloads');
      await mkdir(dir, { recursive: true, mode: SECRET_MODES.dir });
      const filePath = join(
        dir,
        downloadBasename(resolved.canonicalId, q.messageId, info),
      );
      /**
       * Download to a unique sibling and publish only after every cap and mode check, so a
       * failed concurrent attempt can never delete another's completed file and partial bytes
       * never appear at the returned path.
       */
      const partialPath = `${filePath}.part-${randomBytes(8).toString('hex')}`;
      const writer = openDownloadWriter(partialPath);
      let published = false;
      try {
        const written = await this.client.downloadMedia(message, {
          outputFile: writer.output,
          /**
           * GramJS 2.26 ignores the callback's documented `isCanceled`; throwing stops its
           * download iterator, and the sentinel is caught below with the partial removed in
           * finally.
           */
          progressCallback: (downloaded: {
            greater(value: number): boolean;
          }): void => {
            if (downloaded.greater(this.maxDownloadBytes)) {
              throw DOWNLOAD_CAP_ABORT;
            }
          },
        });
        if (typeof written !== 'string') {
          return err(
            appError(
              AppErrorCode.GatewayUnavailable,
              'media download produced no file',
            ),
          );
        }
        // GramJS closes the supplied stream in its own finally but does not await it.
        // Publication begins only after every queued byte and the file descriptor have settled.
        writer.output.close();
        await writer.closed;
        const sizeBytes = (await stat(partialPath)).size;
        if (sizeBytes > this.maxDownloadBytes) {
          return err(downloadCapExceeded(this.maxDownloadBytes));
        }
        await chmod(partialPath, SECRET_MODES.file);
        await rename(partialPath, filePath);
        published = true;
        const mimeType = info.mimeType?.sanitizedValue ?? guessMime(filePath);
        return ok({
          filePath,
          mimeType,
          sizeBytes,
          ...(info.fileName !== undefined ? { fileName: info.fileName } : {}),
        });
      } catch (error) {
        if (error === DOWNLOAD_CAP_ABORT) {
          return err(downloadCapExceeded(this.maxDownloadBytes));
        }
        throw error;
      } finally {
        writer.output.close();
        await writer.closed.catch(() => undefined);
        if (!published) {
          await rm(partialPath, { force: true }).catch(() => undefined);
        }
      }
    });
  }

  public getPinnedMessages(
    q: GetPinnedQuery,
  ): Promise<Result<Page<MessageDto>, AppError>> {
    // Pinned enumeration reuses the search request with the Pinned filter.
    return this.withPeer(q.peer, PermissionVerb.Read, async (resolved) => {
      const batch = await this.invokeScopedSearch(
        resolved.inputPeer,
        clamp(q.limit, 1, DEFAULTS.maxPageItems),
        { filter: new Api.InputMessagesFilterPinned() },
      );
      return batch.ok ? ok({ items: batch.value.items }) : batch;
    });
  }

  public listParticipants(
    q: ListParticipantsQuery,
  ): Promise<Result<Page<ParticipantDto>, AppError>> {
    return this.withPeer(q.peer, PermissionVerb.Read, async (resolved) => {
      // Participants exist only for groups/channels; a user/bot DM has none. The
      // scoped entity cache answers this without a round-trip.
      const entity = this.binding.entities.get(resolved.canonicalId);
      if (entity instanceof Api.User) {
        return err(
          appError(
            AppErrorCode.Validation,
            `peer ${resolved.canonicalId} is a user, not a group/channel; it has no participants`,
          ),
        );
      }
      const limit = clamp(q.limit, 1, DEFAULTS.maxPageItems);
      // High-level enumeration; a private/admin-required channel throws and is mapped
      // to a graceful AppError by withPeer's catch (never a crash).
      const users = await this.client.getParticipants(resolved.inputPeer, {
        limit,
      });
      const items = users
        .filter((u): u is Api.User => u instanceof Api.User)
        .slice(0, limit)
        .map((u) => mapParticipant(u, this.sanitizer));
      return ok({ items });
    });
  }

  public async sendMessage(
    c: SendMessageCommand,
  ): Promise<Result<SendResultDto, AppError>> {
    const replay = this.replayIdempotent(c.idempotencyKey);
    if (replay !== undefined) {
      return ok(replay);
    }
    return this.withPeer(c.peer, PermissionVerb.Send, async (resolved) => {
      const idempotencyKey = c.idempotencyKey ?? mintIdempotencyKey();
      const reply = topicReplyParams(c);
      const message = await this.client.sendMessage(resolved.inputPeer, {
        message: c.text,
        ...(reply.replyToMsgId !== undefined
          ? { replyTo: reply.replyToMsgId }
          : {}),
        ...(reply.topMsgId !== undefined ? { topMsgId: reply.topMsgId } : {}),
      });
      const dto: SendResultDto = {
        chatId: resolved.canonicalId,
        messageId: message.id,
        dateIso: unixToIso(message.date),
        idempotencyKey,
      };
      this.rememberIdempotent(c.idempotencyKey, dto);
      return ok(dto);
    });
  }

  public editMessage(
    c: EditMessageCommand,
  ): Promise<Result<EditResultDto, AppError>> {
    return this.withPeer(c.peer, PermissionVerb.Send, async (resolved) => {
      const message = await this.client.editMessage(resolved.inputPeer, {
        message: c.messageId,
        text: c.text,
      });
      return ok({
        chatId: resolved.canonicalId,
        messageId: message.id,
        editedDateIso: unixToIso(message.editDate ?? message.date),
      });
    });
  }

  public deleteMessage(
    c: DeleteMessageCommand,
  ): Promise<Result<DeleteResultDto, AppError>> {
    return this.withPeer(c.peer, PermissionVerb.Delete, async (resolved) => {
      await this.client.deleteMessages(
        resolved.inputPeer,
        [...c.messageIds],
        { revoke: c.revoke },
      );
      return ok({
        chatId: resolved.canonicalId,
        deletedMessageIds: [...c.messageIds],
        revoked: c.revoke,
      });
    });
  }

  public saveDraft(
    c: SaveDraftCommand,
  ): Promise<Result<DraftResultDto, AppError>> {
    return this.withPeer(c.peer, PermissionVerb.Draft, async (resolved) => {
      const reply = topicReplyParams(c);
      await this.client.invoke(
        new Api.messages.SaveDraft({
          peer: resolved.inputPeer,
          message: c.text,
          ...(reply.replyToMsgId !== undefined
            ? {
                replyTo: new Api.InputReplyToMessage({
                  replyToMsgId: reply.replyToMsgId,
                  ...(reply.topMsgId !== undefined
                    ? { topMsgId: reply.topMsgId }
                    : {}),
                }),
              }
            : {}),
        }),
      );
      return ok({ chatId: resolved.canonicalId, saved: true });
    });
  }

  public markRead(
    c: MarkReadCommand,
  ): Promise<Result<MarkReadResultDto, AppError>> {
    return this.withPeer(c.peer, PermissionVerb.MarkRead, async (resolved) => {
      if (c.topicId !== undefined) {
        // Telegram has no whole-topic form, so the explicit high-water mark is required. The
        // schema enforces it; this re-check keeps the data layer fail-closed.
        if (c.maxMessageId === undefined) {
          return err(
            appError(
              AppErrorCode.Validation,
              'marking a forum topic read requires maxMessageId',
            ),
          );
        }
        // Same forum invariant as the topic-scoped reads: ReadDiscussion on a
        // broadcast channel would address its linked discussion group.
        const forum = this.requireForumPeer(resolved);
        if (!forum.ok) {
          return forum;
        }
        await this.client.invoke(
          new Api.messages.ReadDiscussion({
            peer: resolved.inputPeer,
            msgId: c.topicId,
            readMaxId: c.maxMessageId,
          }),
        );
        return ok({
          chatId: resolved.canonicalId,
          maxReadMessageId: c.maxMessageId,
        });
      }
      await this.client.markAsRead(
        resolved.inputPeer,
        undefined,
        c.maxMessageId !== undefined ? { maxId: c.maxMessageId } : undefined,
      );
      return ok({
        chatId: resolved.canonicalId,
        maxReadMessageId: c.maxMessageId ?? 0,
      });
    });
  }

  public forwardMessage(
    c: ForwardMessageCommand,
  ): Promise<Result<ForwardResultDto, AppError>> {
    return this.withConnection(async () => {
      // Same-scope forward: BOTH peers are scope-checked.
      const from = this.resolvePeerForVerb(c.fromPeer, PermissionVerb.Read);
      if (!from.ok) {
        return from;
      }
      const to = this.resolvePeerForVerb(c.toPeer, PermissionVerb.Forward);
      if (!to.ok) {
        return to;
      }
      const forwarded = await this.client.forwardMessages(to.value.inputPeer, {
        messages: [...c.messageIds],
        fromPeer: from.value.inputPeer,
      });
      return ok({
        fromChatId: from.value.canonicalId,
        toChatId: to.value.canonicalId,
        forwardedMessageIds: forwarded.map((m) => m.id),
      });
    });
  }

  public sendReaction(
    c: SendReactionCommand,
  ): Promise<Result<ReactionResultDto, AppError>> {
    return this.withPeer(c.peer, PermissionVerb.React, async (resolved) => {
      await this.client.invoke(
        new Api.messages.SendReaction({
          peer: resolved.inputPeer,
          msgId: c.messageId,
          reaction: [new Api.ReactionEmoji({ emoticon: c.emoji })],
        }),
      );
      return ok({
        chatId: resolved.canonicalId,
        messageId: c.messageId,
        emoji: c.emoji,
      });
    });
  }

  public prepareMedia(
    c: PrepareMediaCommand,
  ): Promise<Result<MediaHandleDto, AppError>> {
    const live = this.ensureLive();
    if (!live.ok) {
      return Promise.resolve(live);
    }
    // Reserve before the first await so concurrent preparations cannot all pass
    // the cap while filesystem checks are in flight.
    this.sweepExpiredMediaHandles();
    if (
      this.mediaHandles.size + this.pendingMediaPreparations >=
      MAX_LIVE_MEDIA_HANDLES
    ) {
      return Promise.resolve(
        err(
          appError(
            AppErrorCode.QuotaExceeded,
            'too many pending media handles; send or let existing handles expire before preparing more',
          ),
        ),
      );
    }
    this.pendingMediaPreparations += 1;
    return this.trackOperation(this.prepareMediaReserved(c));
  }

  private async prepareMediaReserved(
    c: PrepareMediaCommand,
  ): Promise<Result<MediaHandleDto, AppError>> {
    try {
      /**
       * FILESYSTEM CONFINEMENT: the model supplies an arbitrary path, so canonicalize it
       * through symlinks and accept it only when it resolves to a regular file INSIDE the
       * allow-listed upload root — otherwise a `send`-capable endpoint could exfiltrate any
       * readable file.
       */
      const confined = await this.resolveWithinRoot(c.localPath);
      if (!confined.ok) {
        return confined;
      }
      if (confined.value.size > DEFAULTS.maxMediaBytes) {
        return err(
          appError(
            AppErrorCode.SizeCapExceeded,
            `media exceeds the ${String(DEFAULTS.maxMediaBytes)}-byte cap`,
          ),
        );
      }

      // Disposal may have started while the filesystem checks were in flight.
      // Never publish a handle into a retired scoped client.
      const live = this.ensureLive();
      if (!live.ok) {
        return live;
      }

      const mimeType = guessMime(confined.value.realPath);
      const handle = mintHandle();
      const expiresAtMs = this.clock.nowMs() + DEFAULTS.mediaHandleTtlMs;
      const expiresAtIso = new Date(
        Date.parse(this.clock.nowIso()) + DEFAULTS.mediaHandleTtlMs,
      ).toISOString();
      // Store the RESOLVED real path (not the model-supplied path) in the handle.
      this.mediaHandles.set(handle, {
        localPath: confined.value.realPath,
        sizeBytes: confined.value.size,
        mimeType,
        expiresAtMs,
      });
      return ok({
        handle,
        expiresAtIso,
        sizeBytes: confined.value.size,
        mimeType,
      });
    } finally {
      this.pendingMediaPreparations -= 1;
    }
  }

  public async sendMedia(
    c: SendMediaCommand,
  ): Promise<Result<SendResultDto, AppError>> {
    const replay = this.replayIdempotent(c.idempotencyKey);
    if (replay !== undefined) {
      return ok(replay);
    }
    const live = this.ensureLive();
    if (!live.ok) {
      return live;
    }

    const entry = this.mediaHandles.get(c.handle);
    if (entry === undefined) {
      return err(appError(AppErrorCode.InvalidMediaHandle, 'unknown media handle'));
    }
    if (entry.expiresAtMs <= this.clock.nowMs()) {
      this.mediaHandles.delete(c.handle);
      return err(appError(AppErrorCode.InvalidMediaHandle, 'media handle expired'));
    }

    /**
     * TOCTOU close: re-canonicalize, re-confine and re-cap the stored path immediately before
     * upload. The file or a path component could have been swapped between prepare and send,
     * and a single-use handle that no longer points to an in-root regular file fails closed.
     */
    const confined = await this.resolveWithinRoot(entry.localPath);
    if (!confined.ok) {
      this.mediaHandles.delete(c.handle);
      return confined;
    }
    if (confined.value.size > DEFAULTS.maxMediaBytes) {
      this.mediaHandles.delete(c.handle);
      return err(
        appError(
          AppErrorCode.SizeCapExceeded,
          `media exceeds the ${String(DEFAULTS.maxMediaBytes)}-byte cap`,
        ),
      );
    }

    return this.withPeer(c.peer, PermissionVerb.Send, async (resolved) => {
      const idempotencyKey = c.idempotencyKey ?? mintIdempotencyKey();
      const reply = topicReplyParams(c);
      const message = await this.client.sendFile(resolved.inputPeer, {
        file: confined.value.realPath,
        ...(c.caption !== undefined ? { caption: c.caption } : {}),
        ...(reply.replyToMsgId !== undefined
          ? { replyTo: reply.replyToMsgId }
          : {}),
        ...(reply.topMsgId !== undefined ? { topMsgId: reply.topMsgId } : {}),
      });
      this.mediaHandles.delete(c.handle); // single-use
      const dto: SendResultDto = {
        chatId: resolved.canonicalId,
        messageId: message.id,
        dateIso: unixToIso(message.date),
        idempotencyKey,
      };
      this.rememberIdempotent(c.idempotencyKey, dto);
      return ok(dto);
    });
  }

  public dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.mediaHandles.clear();
      this.idempotency.clear();
    }
    /**
     * Draining the endpoint's active operations is part of the gateway's ownership barrier: no
     * operation may create/use an exported sender after the gateway has started destroying the
     * physical client.
     */
    this.disposing ??= Promise.allSettled([...this.activeOperations]).then(
      () => undefined,
    );
    return this.disposing;
  }

  private toMessageDto(message: Api.Message): MessageDto {
    return mapMessage(message, {
      sanitizer: this.sanitizer,
      resolveDisplayName: (id) => this.binding.displayNames.get(id.toString()),
      isForumChat: (id) => {
        const entity = this.binding.entities.get(id.toString());
        return entity !== undefined && isForumOf(entity);
      },
    });
  }

  private toPeerSearchPage(batch: MessageSearchBatch): Page<MessageDto> {
    return {
      items: batch.items,
      ...(batch.nextOffsetId !== undefined
        ? { nextCursor: encodePeerSearchCursor(batch.nextOffsetId) }
        : {}),
    };
  }

  /**
   * The ONE messages.Search invocation (plain peer search, whole-scope fan-out,
   * topic-scoped search via `topMsgId`, and pinned enumeration via `filter`),
   * always addressed exclusively through the scoped input handle.
   */
  private async invokeScopedSearch(
    inputPeer: Api.TypeInputPeer,
    limit: number,
    extra: {
      readonly q?: string;
      readonly topMsgId?: number;
      readonly filter?: Api.TypeMessagesFilter;
      readonly offsetId?: number;
    },
  ): Promise<Result<MessageSearchBatch, AppError>> {
    try {
      const probeLimit = Math.min(limit + 1, DEFAULTS.maxPageItems);
      const result = await this.client.invoke(
        new Api.messages.Search({
          peer: inputPeer,
          q: extra.q ?? '',
          ...(extra.topMsgId !== undefined ? { topMsgId: extra.topMsgId } : {}),
          filter: extra.filter ?? new Api.InputMessagesFilterEmpty(),
          minDate: 0,
          maxDate: 0,
          offsetId: extra.offsetId ?? 0,
          addOffset: 0,
          limit: probeLimit,
          maxId: 0,
          minId: 0,
          hash: helpers.returnBigInt(0),
        }),
      );
      const messages =
        result instanceof Api.messages.MessagesNotModified
          ? []
          : result.messages;
      const found = messages.filter(
        (m): m is Api.Message => m instanceof Api.Message,
      );
      const kept = found.slice(0, limit);
      const last = kept[kept.length - 1];
      const mayHaveMore =
        found.length > limit ||
        (probeLimit === limit && found.length >= limit);
      return ok({
        items: kept.map((m) => this.toMessageDto(m)),
        ...(mayHaveMore && last !== undefined ? { nextOffsetId: last.id } : {}),
      });
    } catch (error) {
      return err(mapGramjsError(error));
    }
  }

  // Fetch ONE in-scope message by id and its media info (shared opening of getMediaInfo /
  // downloadMedia). `noMedia` names the caller's error for a message that carries no media.
  private async fetchMediaInfo(
    resolved: ResolvedPeer,
    messageId: number,
    noMedia: { readonly code: AppErrorCode; readonly message: string },
  ): Promise<Result<{ message: Api.Message; info: MediaInfoDto }, AppError>> {
    const list = await this.client.getMessages(resolved.inputPeer, {
      ids: [messageId],
    });
    const message = list.find((m): m is Api.Message => m instanceof Api.Message);
    if (message === undefined) {
      return err(
        appError(
          AppErrorCode.NotFound,
          `message ${String(messageId)} not in scope`,
        ),
      );
    }
    const info = mapMediaInfo(message, this.sanitizer);
    if (info === undefined) {
      return err(appError(noMedia.code, noMedia.message));
    }
    return ok({ message, info });
  }

  /**
   * Canonicalize `rawPath` and confine it to the allow-listed media root,
   * returning the resolved real path + size only for a regular file inside the
   * root. `realpath` follows symlinks, so a symlink escaping the root resolves
   * to its out-of-root target and is rejected (fail-closed).
   */
  private async resolveWithinRoot(
    rawPath: string,
  ): Promise<Result<{ realPath: string; size: number }, AppError>> {
    let realRoot: string;
    try {
      realRoot = await realpath(this.mediaRootDir);
    } catch {
      return err(
        appError(
          AppErrorCode.GatewayUnavailable,
          'configured media root directory is not accessible',
        ),
      );
    }
    /**
     * A non-existent path and an existing out-of-root path MUST return the SAME error; distinct
     * codes would turn prepare_media into a filesystem existence oracle over arbitrary host
     * paths (probe `~/.ssh/id_ed25519` etc.). Existence is revealed only for paths inside the
     * allow-listed root.
     */
    const notInRoot = (): Result<never, AppError> =>
      err(
        appError(
          AppErrorCode.NotFound,
          'media file is not an accessible regular file within the allowed upload directory',
        ),
      );
    let realPath: string;
    try {
      realPath = await realpath(rawPath);
    } catch {
      return notInRoot();
    }
    const rootPrefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
    if (!realPath.startsWith(rootPrefix)) {
      return notInRoot();
    }
    let stats;
    try {
      stats = await stat(realPath);
    } catch {
      return notInRoot();
    }
    if (!stats.isFile()) {
      return err(
        appError(AppErrorCode.Validation, 'media path is not a regular file'),
      );
    }
    return ok({ realPath, size: stats.size });
  }

  // Drop expired media handles; one never re-presented would otherwise live until dispose,
  // growing unbounded under repeated prepare.
  private sweepExpiredMediaHandles(): void {
    const now = this.clock.nowMs();
    for (const [handle, entry] of this.mediaHandles) {
      if (entry.expiresAtMs <= now) {
        this.mediaHandles.delete(handle);
      }
    }
  }

  private replayIdempotent(key: string | undefined): SendResultDto | undefined {
    return key !== undefined ? this.idempotency.get(key) : undefined;
  }

  private rememberIdempotent(key: string | undefined, dto: SendResultDto): void {
    if (key === undefined) {
      return;
    }
    this.idempotency.set(key, dto);
    // Bound the best-effort replay cache: evict oldest-first (Map keeps insertion
    // order) so a long-lived endpoint cannot leak memory one send at a time.
    while (this.idempotency.size > MAX_IDEMPOTENCY_KEYS) {
      const oldest = this.idempotency.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.idempotency.delete(oldest);
    }
  }

  // Reject any operation once the client is disposed (fail-closed).
  private ensureLive(): Result<void, AppError> {
    if (this.disposed) {
      return err(
        appError(AppErrorCode.GatewayUnavailable, 'scoped client was disposed'),
      );
    }
    return ok(undefined);
  }

  // Ask the gateway's one lifecycle controller to establish readiness.
  private async ensureConnected(): Promise<Result<void, AppError>> {
    const live = this.ensureLive();
    if (!live.ok) {
      return live;
    }
    const ready = await this.ensureGatewayConnected();
    if (!ready.ok) {
      return ready;
    }
    return this.ensureLive();
  }

  /**
   * The shared opening for every peer-addressed op: ensure the connection is
   * live, run the scope gate + per-chat override check for `verb`, then run the
   * op with GramJS throws mapped to AppError. `fn` receives the resolved,
   * in-scope peer and owns the specifics (topic params, pagination, …).
   */
  private withPeer<T>(
    peer: PeerRef,
    verb: PermissionVerb,
    fn: (resolved: ResolvedPeer) => Promise<Result<T, AppError>>,
  ): Promise<Result<T, AppError>> {
    return this.withConnection(() => {
      const resolved = this.resolvePeerForVerb(peer, verb);
      return resolved.ok ? fn(resolved.value) : Promise.resolve(resolved);
    });
  }

  /**
   * The peer-less sibling of {@link withPeer}: ensure the connection is live and
   * map GramJS throws, for ops that address the scope as a whole (list_dialogs)
   * or resolve their own peers inside `fn` (forward's two-peer scope check).
   */
  private withConnection<T>(
    fn: () => Promise<Result<T, AppError>>,
  ): Promise<Result<T, AppError>> {
    const live = this.ensureLive();
    if (!live.ok) {
      return Promise.resolve(live);
    }
    return this.trackOperation(this.withConnectionLive(fn));
  }

  private async withConnectionLive<T>(
    fn: () => Promise<Result<T, AppError>>,
  ): Promise<Result<T, AppError>> {
    const ready = await this.ensureConnected();
    if (!ready.ok) {
      return ready;
    }
    try {
      return await fn();
    } catch (error) {
      return err(mapGramjsError(error));
    }
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.activeOperations.add(operation);
    void operation.then(
      () => this.activeOperations.delete(operation),
      () => this.activeOperations.delete(operation),
    );
    return operation;
  }

  /**
   * THE scope gate: resolve a `PeerRef` to its cached input handle AND enforce
   * its per-chat verb override in one place. Usernames/`me` resolve only against
   * this endpoint's scoped caches, never a network lookup. An override replaces
   * the group default for that chat, so a resolved peer carrying one must satisfy
   * it or the op is denied (fail-closed); the group-default gate is upstream.
   */
  private resolvePeerForVerb(
    peer: PeerRef,
    verb: PermissionVerb,
  ): Result<ResolvedPeer, AppError> {
    const resolved = this.resolvePeerUnchecked(peer);
    if (!resolved.ok) {
      return resolved;
    }
    if (
      !chatOverridePermitsVerb({
        key: resolved.value.canonicalId,
        verb,
        overrides: this.overrides,
      })
    ) {
      return err(
        appError(
          AppErrorCode.AclDenied,
          `peer ${resolved.value.canonicalId} restricts this action by a per-chat override`,
        ),
      );
    }
    return resolved;
  }

  /**
   * Enforce "a topicId addresses a FORUM supergroup, never anything else". In a
   * genuine forum the thread lives in the SAME peer, but `messages.GetReplies`
   * on a BROADCAST CHANNEL post returns the comment thread belonging to the
   * channel's LINKED DISCUSSION supergroup — a peer the operator never scoped.
   * Confining a topicId to an already-resolved forum peer keeps it a refinement
   * of an in-scope chat. Reads the scoped entity cache only (no round-trip).
   */
  private requireForumPeer(resolved: ResolvedPeer): Result<void, AppError> {
    const entity = this.binding.entities.get(resolved.canonicalId);
    if (entity === undefined || !isForumOf(entity)) {
      return err(
        appError(
          AppErrorCode.Validation,
          `peer ${resolved.canonicalId} is not a forum supergroup; topics exist only in forums (see get_chat_info isForum)`,
        ),
      );
    }
    return ok(undefined);
  }

  private resolvePeerUnchecked(peer: PeerRef): Result<ResolvedPeer, AppError> {
    switch (peer.kind) {
      case 'id':
        return this.resolveByChatId(peer.id);
      case 'me': {
        const idRes = ChatId.create(this.selfId);
        if (!idRes.ok) {
          return err(
            appError(AppErrorCode.GatewayUnavailable, 'self identity unavailable'),
          );
        }
        return this.resolveByChatId(idRes.value);
      }
      case 'username': {
        const key = this.binding.usernameIndex.get(peer.username.toLowerCase());
        if (key === undefined) {
          return err(
            appError(
              AppErrorCode.NotFound,
              `@${peer.username} is not within this endpoint's scope`,
            ),
          );
        }
        const inputPeer = this.binding.inputPeers.get(key);
        if (inputPeer === undefined) {
          return err(
            appError(AppErrorCode.NotFound, `@${peer.username} is unaddressable`),
          );
        }
        const chatId = ChatId.fromString(key);
        if (!chatId.ok) {
          return err(
            appError(AppErrorCode.Validation, 'Resolved username has an invalid peer id'),
          );
        }
        return ok({ inputPeer, chatId: chatId.value, canonicalId: key });
      }
    }
  }

  private resolveByChatId(id: ChatId): Result<ResolvedPeer, AppError> {
    if (!this.scope.contains(id)) {
      return err(
        appError(
          AppErrorCode.AclDenied,
          `peer ${id.toKey()} is outside this endpoint's scope`,
        ),
      );
    }
    const inputPeer = this.binding.inputPeers.get(id.toKey());
    if (inputPeer === undefined) {
      return err(
        appError(
          AppErrorCode.NotFound,
          `peer ${id.toKey()} is in scope but unaddressable`,
        ),
      );
    }
    return ok({ inputPeer, chatId: id, canonicalId: id.toKey() });
  }
}
