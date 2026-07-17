/**
 * GramjsTelegramGateway lifecycle — dispose() as a COMPLETE ownership barrier.
 *
 * Telegram's auth key has exactly ONE owner-connection; the daemon admits a
 * replacement gateway only after the old one's dispose() resolves. Pinned here:
 *  - dispose() does NOT resolve while an openShared() is mid-connect (resolving
 *    early would declare the key free just as the old connection comes up);
 *  - CONCURRENT dispose() callers share ONE teardown — no caller sees "done"
 *    before the connection is actually gone;
 *  - scoped and GramJS-triggered reconnects share one gateway-owned promise,
 *    which disposal drains before destroying the physical client;
 *  - in-flight scoped RPCs drain before sender teardown;
 *  - scope resolution and binding reuse one physical client;
 *  - a FAILED final destroy propagates (the retirement chain reports TEARDOWN
 *    FAILED) instead of being swallowed into a silently-"complete" barrier;
 *  - binds after dispose are refused; dispose is idempotent.
 *
 * Driven through a fake TelegramClient via the `clientFactory` seam (no
 * network). The authorized path uses REAL Api.User entities so buildBinding /
 * canonicalIdOf run for real.
 */
import { describe, it, expect } from 'vitest';
import { Api, helpers } from 'telegram';
import type { TelegramClient } from 'telegram';

import { GramjsTelegramGateway } from '../../src/infrastructure/telegram/gramjs-telegram-gateway.js';
import {
  UnicodeSanitizer,
} from '../../src/infrastructure/index.js';
import { isErr, isOk, ok } from '../../src/shared/index.js';
import { PermissionVerb, PeerRefFactory } from '../../src/domain/index.js';
import {
  FakeClock,
  IN_SCOPE,
  buildEndpoint,
  resolvedScope,
} from '../application/_support.js';

/** Let every currently-queued microtask/timer-0 run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The one in-scope peer (id 100, matching _support's IN_SCOPE) as a real Api entity. */
const scopedUser = (): Api.User =>
  new Api.User({
    id: helpers.returnBigInt(100),
    accessHash: helpers.returnBigInt(0),
    firstName: 'Scoped',
  });

/**
 * A fake TelegramClient: gated connect (manual release), configurable
 * authorization, destroy/disconnect spies, and just enough dialog surface for
 * buildBinding to mint a real scoped binding over IN_SCOPE.
 */
class FakeTelegramClient {
  public connectCalls = 0;
  public destroyCalls = 0;
  public disconnectCalls = 0;
  public connected = false;
  public failDestroy = false;
  public iteratedDialogs = 0;
  public getDialogsCalls = 0;
  private releaseConnect: (() => void) | undefined;
  private connectGate: Promise<void>;
  private releaseRequest: (() => void) | undefined;
  private requestGate: Promise<void> = Promise.resolve();
  public readonly sender = {
    userDisconnected: false,
    reconnect: (): void => undefined,
    _reconnect: (): Promise<void> => Promise.resolve(),
  };
  public readonly _sender = this.sender;
  public _createExportedSender(): typeof this.sender {
    return this.sender;
  }

  public constructor(private readonly authorized: boolean) {
    this.connectGate = new Promise<void>((release) => {
      this.releaseConnect = release;
    });
  }

  public finishConnect(): void {
    this.releaseConnect?.();
  }

  /** Re-arm the gate so the NEXT connect() parks again (reconnect scenarios). */
  public gateNextConnect(): void {
    this.connectGate = new Promise<void>((release) => {
      this.releaseConnect = release;
    });
  }

  public gateNextRequest(): void {
    this.requestGate = new Promise<void>((release) => {
      this.releaseRequest = release;
    });
  }

  public finishRequest(): void {
    this.releaseRequest?.();
  }

  public async connect(): Promise<void> {
    this.connectCalls += 1;
    await this.connectGate;
    this.connected = true;
  }

  public isUserAuthorized(): Promise<boolean> {
    return Promise.resolve(this.authorized);
  }

  public getMe(): Promise<Api.User> {
    return Promise.resolve(
      new Api.User({ id: helpers.returnBigInt(7), firstName: 'Self' }),
    );
  }

  public getDialogs(): Promise<
    readonly { entity: Api.User; inputEntity: Api.TypeInputPeer }[]
  > {
    this.getDialogsCalls += 1;
    return Promise.resolve([
      {
        entity: scopedUser(),
        inputEntity: new Api.InputPeerUser({
          userId: helpers.returnBigInt(100),
          accessHash: helpers.returnBigInt(0),
        }),
      },
    ]);
  }

  public async *iterDialogs(): AsyncGenerator<{
    readonly entity: Api.User;
    readonly inputEntity: Api.TypeInputPeer;
    readonly unreadCount: number;
    readonly pinned: boolean;
  }> {
    await Promise.resolve();
    this.iteratedDialogs += 1;
    yield {
      entity: scopedUser(),
      inputEntity: new Api.InputPeerUser({
        userId: helpers.returnBigInt(100),
        accessHash: helpers.returnBigInt(0),
      }),
      unreadCount: 0,
      pinned: false,
    };
    throw new Error('dialog iteration should stop after satisfying the scope/limit');
  }

  public invoke<R extends Api.AnyRequest>(request: R): Promise<R['__response']> {
    if (request instanceof Api.messages.GetDialogFilters) {
      return Promise.resolve(
        new Api.messages.DialogFilters({ filters: [] }) as R['__response'],
      );
    }
    return Promise.reject(new Error('unexpected request'));
  }

  public async getMessages(): Promise<readonly Api.Message[]> {
    await this.requestGate;
    return [];
  }

  public destroy(): Promise<void> {
    this.destroyCalls += 1;
    this.connected = false;
    if (this.failDestroy) {
      return Promise.reject(new Error('destroy blew up'));
    }
    return Promise.resolve();
  }

  public disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.connected = false;
    return Promise.resolve();
  }
}

const buildGateway = (fake: FakeTelegramClient): GramjsTelegramGateway =>
  new GramjsTelegramGateway({
    apiId: 1,
    apiHash: 'test-hash',
    sessionSecret: 'test-session-secret',
    mediaRootDir: 'media',
    sanitizer: new UnicodeSanitizer(),
    clock: new FakeClock(),
    clientFactory: () => fake as unknown as TelegramClient,
  });

const bind = (
  gateway: GramjsTelegramGateway,
): ReturnType<GramjsTelegramGateway['bindScopedClient']> =>
  gateway.bindScopedClient({
    endpoint: buildEndpoint({ verbs: [PermissionVerb.Read] }),
    resolvedScope: resolvedScope(),
    overrides: new Map(),
  });

describe('GramjsTelegramGateway dispose() — the auth-key ownership barrier', () => {
  it('does NOT resolve while an openShared is still mid-connect; the client never survives', async () => {
    const fake = new FakeTelegramClient(false);
    const gateway = buildGateway(fake);

    // Start a bind: openShared() is now parked inside the fake's connect().
    const binding = bind(gateway);
    await settle();

    let disposeResolved = false;
    const disposing = gateway.dispose().then(() => {
      disposeResolved = true;
    });
    await settle();
    // The open is still in flight — declaring the key free here would let a
    // replacement connect while this one comes up.
    expect(disposeResolved).toBe(false);

    fake.finishConnect();
    await disposing;
    expect(disposeResolved).toBe(true);
    // Whatever the open produced was destroyed, not leaked.
    expect(fake.destroyCalls).toBeGreaterThanOrEqual(1);
    expect(fake.connected).toBe(false);

    const bound = await binding;
    expect(isErr(bound)).toBe(true);
  });

  it('CONCURRENT dispose callers share one teardown: neither resolves early', async () => {
    const fake = new FakeTelegramClient(false);
    const gateway = buildGateway(fake);
    const binding = bind(gateway); // parks in connect()
    await settle();

    let firstResolved = false;
    let secondResolved = false;
    const first = gateway.dispose().then(() => {
      firstResolved = true;
    });
    const second = gateway.dispose().then(() => {
      secondResolved = true;
    });
    await settle();
    // The second caller must NOT return early on the disposed flag: its promise
    // resolving is a claim that the connection is gone.
    expect(firstResolved).toBe(false);
    expect(secondResolved).toBe(false);

    fake.finishConnect();
    await Promise.all([first, second]);
    expect(fake.destroyCalls).toBeGreaterThanOrEqual(1);
    expect(fake.connected).toBe(false);
    await binding;
  });

  it('dispose waits for a scoped operation using the gateway reconnect path', async () => {
    const fake = new FakeTelegramClient(true);
    fake.finishConnect(); // the initial open connects immediately
    const gateway = buildGateway(fake);
    const bound = await bind(gateway);
    expect(isOk(bound)).toBe(true);
    if (!isOk(bound)) return;
    const scoped = bound.value;

    // A transient network drop, then an op starts the LAZY reconnect and parks.
    fake.connected = false;
    fake.gateNextConnect();
    const op = scoped.getMessages({
      peer: PeerRefFactory.fromId(IN_SCOPE),
      limit: 1,
    });
    await settle();

    let disposeResolved = false;
    const disposing = gateway.dispose().then(() => {
      disposeResolved = true;
    });
    await settle();
    expect(disposeResolved).toBe(false);

    fake.finishConnect();
    await disposing;
    const res = await op;
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.message).toContain('disposed');
    }
    expect(fake.connected).toBe(false);
    expect(fake.destroyCalls).toBeGreaterThanOrEqual(1);
  });

  it('routes a GramJS sender reconnect through the same disposal barrier', async () => {
    const fake = new FakeTelegramClient(true);
    fake.finishConnect();
    const gateway = buildGateway(fake);
    expect(isOk(await bind(gateway))).toBe(true);

    fake.gateNextConnect();
    fake.sender.reconnect();
    await settle();

    let disposeResolved = false;
    const disposing = gateway.dispose().then(() => {
      disposeResolved = true;
    });
    await settle();
    expect(disposeResolved).toBe(false);

    fake.finishConnect();
    await disposing;
    expect(fake.connected).toBe(false);

    const callsAfterDispose = fake.connectCalls;
    await fake.sender._reconnect(); // queued callbacks are neutralized
    expect(fake.connectCalls).toBe(callsAfterDispose);
  });

  it('drains an in-flight scoped RPC before destroying the shared client', async () => {
    const fake = new FakeTelegramClient(true);
    fake.finishConnect();
    const gateway = buildGateway(fake);
    const bound = await bind(gateway);
    expect(isOk(bound)).toBe(true);
    if (!isOk(bound)) return;

    fake.gateNextRequest();
    const request = bound.value.getMessages({
      peer: PeerRefFactory.fromId(IN_SCOPE),
      limit: 1,
    });
    await settle();

    let disposeResolved = false;
    const disposing = gateway.dispose().then(() => {
      disposeResolved = true;
    });
    await settle();
    expect(disposeResolved).toBe(false);
    expect(fake.destroyCalls).toBe(0);

    fake.finishRequest();
    expect(isOk(await request)).toBe(true);
    await disposing;
    expect(fake.destroyCalls).toBe(1);
  });

  it('reuses one physical client for resolution, account snapshots, and scoped binding', async () => {
    const fake = new FakeTelegramClient(true);
    fake.finishConnect();
    const gateway = buildGateway(fake);
    const sessionRef = buildEndpoint({ verbs: [PermissionVerb.Read] }).sessionRef;

    const resolved = await gateway.withClient(sessionRef, (client) => {
      expect(client).toBe(fake);
      return Promise.resolve(ok(undefined));
    });
    expect(isOk(resolved)).toBe(true);
    const snapshot = await gateway.snapshotAccount(sessionRef);
    expect(isOk(snapshot)).toBe(true);
    if (isOk(snapshot)) {
      expect(snapshot.value.chats.map((chat) => chat.title)).toEqual(['Scoped']);
    }
    const bound = await bind(gateway);
    expect(isOk(bound)).toBe(true);
    expect(fake.connectCalls).toBe(1);
    expect(fake.getDialogsCalls).toBe(1); // the full snapshot intentionally needs all
    expect(fake.iteratedDialogs).toBe(1); // scoped binding resolves the peer once
  });

  it('propagates cleanup failure from an aborted open through dispose', async () => {
    const fake = new FakeTelegramClient(false);
    fake.failDestroy = true;
    fake.finishConnect();
    const gateway = buildGateway(fake);

    expect(isErr(await bind(gateway))).toBe(true);
    await expect(gateway.dispose()).rejects.toThrow('destroy blew up');
  });

  it('a FAILED final destroy PROPAGATES — an uncertain teardown is never a silent success', async () => {
    const fake = new FakeTelegramClient(true);
    fake.finishConnect();
    const gateway = buildGateway(fake);
    expect(isOk(await bind(gateway))).toBe(true); // shared client established

    fake.failDestroy = true;
    // The retirement chain catches this and reports TEARDOWN FAILED; what it
    // must never get is a resolved promise over a connection of unknown state.
    await expect(gateway.dispose()).rejects.toThrow('destroy blew up');
    // The memoized teardown stays failed for later callers too (idempotent).
    await expect(gateway.dispose()).rejects.toThrow('destroy blew up');
  });

  it('a bind AFTER dispose is refused outright (no new ownership, ever)', async () => {
    const fake = new FakeTelegramClient(false);
    fake.finishConnect();
    const gateway = buildGateway(fake);
    await gateway.dispose();

    const bound = await bind(gateway);
    expect(isErr(bound)).toBe(true);
    if (isErr(bound)) {
      expect(bound.error.message).toContain('disposed');
    }
  });

  it('dispose is idempotent (a second call is a no-op, no double teardown)', async () => {
    const fake = new FakeTelegramClient(false);
    fake.finishConnect();
    const gateway = buildGateway(fake);
    await bind(gateway); // fails on the unauthorized fake; irrelevant here

    await gateway.dispose();
    const callsAfterFirst = fake.destroyCalls;
    await gateway.dispose();
    expect(fake.destroyCalls).toBe(callsAfterFirst);
  });
});
