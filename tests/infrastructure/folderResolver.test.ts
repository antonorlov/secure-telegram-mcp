/**
 * DialogFilterFolderResolver — security-focused unit tests for the FOLDER
 * differentiator (#5) and the SCOPED-CLIENT INVARIANT (#1).
 *
 * What we pin down here, against the published contracts (no real network):
 *  - FOLDER -> peer resolution: a dialog filter contributes pinned ∪ included
 *    peers, MINUS excluded peers, mapped to OUR canonical `ChatId` space;
 *    `InputPeerSelf` resolves to the account id (once), `InputPeerEmpty` and
 *    unknown peers contribute nothing.
 *  - LANGUAGE FOR ARGS: username/`me` chat refs are resolved INSIDE the data
 *    layer (via the loaned client), never the schema layer; a pure `id` scope
 *    issues no MTProto request (the invariant stays cheap).
 *  - FAIL-CLOSED: a scope resolving to zero peers is rejected (never allow-all),
 *    and a folder/username that cannot be resolved is a hard error (a typo must
 *    not silently narrow a scope to nothing).
 *  - NO CACHE: every resolve re-resolves afresh; failures are never sticky.
 *  - Encapsulation: GramJS errors (incl. FLOOD_WAIT) are mapped to `AppError`
 *    and never escape the adapter.
 *
 * Ports are faked; GramJS `Api` objects are constructed for real so the mapping
 * arithmetic (`InputPeer` -> canonical bigint) is exercised end-to-end.
 */
import { describe, it, expect } from 'vitest';
import { Api, errors, helpers } from 'telegram';
import { unwrap, isErr, type Result } from '../../src/shared/result.js';
import {
  ChatId,
  Scope,
  PeerRefFactory,
  FolderRefFactory,
  SessionRef,
  type ResolvedScope,
  type PeerRef,
  type FolderRef,
  type SessionRefValue,
} from '../../src/domain/index.js';
import {
  AppErrorCode,
  type AppError,
  type ResolvedAccess,
} from '../../src/application/index.js';
import {
  DialogFilterFolderResolver,
  type DialogFilterClient,
  type DialogFilterClientProvider,
} from '../../src/infrastructure/telegram/DialogFilterFolderResolver.js';

// --------------------------------------------------------------------------
// Canonical ("marked") id arithmetic — mirrors telegram-peer-id.ts so the test
// states the expected identity independently of the implementation under test.
// --------------------------------------------------------------------------
const CHANNEL_ID_MARK = -1_000_000_000_000n;
const userCanonical = (id: string): bigint => BigInt(id);
const basicGroupCanonical = (id: string): bigint => -BigInt(id);
const channelCanonical = (id: string): bigint => CHANNEL_ID_MARK - BigInt(id);

// --------------------------------------------------------------------------
// GramJS Api builders (real objects — exercise the real `className` discriminant)
// --------------------------------------------------------------------------
const inputUser = (id: string): Api.TypeInputPeer =>
  new Api.InputPeerUser({
    userId: helpers.returnBigInt(id),
    accessHash: helpers.returnBigInt('0'),
  });

const inputBasicGroup = (id: string): Api.TypeInputPeer =>
  new Api.InputPeerChat({ chatId: helpers.returnBigInt(id) });

const inputChannel = (id: string): Api.TypeInputPeer =>
  new Api.InputPeerChannel({
    channelId: helpers.returnBigInt(id),
    accessHash: helpers.returnBigInt('0'),
  });

const inputSelf = (): Api.TypeInputPeer => new Api.InputPeerSelf();
const inputEmpty = (): Api.TypeInputPeer => new Api.InputPeerEmpty();

const dialogFilter = (config: {
  readonly id: number;
  readonly title: string;
  readonly pinned?: readonly Api.TypeInputPeer[];
  readonly include?: readonly Api.TypeInputPeer[];
  readonly exclude?: readonly Api.TypeInputPeer[];
}): Api.TypeDialogFilter =>
  new Api.DialogFilter({
    id: config.id,
    title: new Api.TextWithEntities({ text: config.title, entities: [] }),
    pinnedPeers: [...(config.pinned ?? [])],
    includePeers: [...(config.include ?? [])],
    excludePeers: [...(config.exclude ?? [])],
  });

const defaultFilter = (): Api.TypeDialogFilter => new Api.DialogFilterDefault();

// --------------------------------------------------------------------------
// Domain builders
// --------------------------------------------------------------------------
const session = (name = 'primary'): SessionRefValue =>
  unwrap(SessionRef.create(name));
const SESSION = session();

const idChat = (id: bigint): PeerRef =>
  PeerRefFactory.fromId(unwrap(ChatId.create(id)));
const usernameChat = (name: string): PeerRef =>
  unwrap(PeerRefFactory.fromUsername(name));
const meChat = (): PeerRef => PeerRefFactory.me();

const folderById = (id: number): FolderRef => unwrap(FolderRefFactory.fromId(id));
const folderByTitle = (title: string): FolderRef =>
  unwrap(FolderRefFactory.fromTitle(title));

const scopeOf = (
  chats: readonly PeerRef[],
  folders: readonly FolderRef[],
): Scope => Scope.create(chats, folders);

// --------------------------------------------------------------------------
// Port fakes
// --------------------------------------------------------------------------
interface FakeClientConfig {
  readonly filters?: readonly Api.TypeDialogFilter[];
  /** Maps the exact `getPeerId` argument (e.g. 'me', '@name') to a canonical id string. */
  readonly peerIds?: Readonly<Record<string, string>>;
  /** Errors thrown by successive `invoke` calls (FIFO); exhausting the queue succeeds. */
  readonly invokeErrors?: readonly Error[];
  /** Errors thrown by `getPeerId` for a given argument. */
  readonly getPeerIdErrors?: Readonly<Record<string, Error>>;
}

class FakeDialogFilterClient implements DialogFilterClient {
  public invokeCalls = 0;
  public readonly getPeerIdCalls: {
    readonly peer: string;
    readonly addMark: boolean | undefined;
  }[] = [];

  private readonly response: Api.messages.DialogFilters;
  private readonly peerIds: ReadonlyMap<string, string>;
  private readonly invokeErrorQueue: Error[];
  private readonly getPeerIdErrors: ReadonlyMap<string, Error>;

  public constructor(config: FakeClientConfig) {
    this.response = new Api.messages.DialogFilters({
      filters: [...(config.filters ?? [])],
    });
    this.peerIds = new Map(Object.entries(config.peerIds ?? {}));
    this.invokeErrorQueue = [...(config.invokeErrors ?? [])];
    this.getPeerIdErrors = new Map(Object.entries(config.getPeerIdErrors ?? {}));
  }

  public invoke<R extends Api.AnyRequest>(_request: R): Promise<R['__response']> {
    this.invokeCalls += 1;
    const queued = this.invokeErrorQueue.shift();
    if (queued !== undefined) {
      return Promise.reject(queued);
    }
    // The resolver only ever invokes `messages.GetDialogFilters`; the double
    // cast bridges the fake's concrete response to the request's phantom type.
    return Promise.resolve(this.response as unknown as R['__response']);
  }

  public getPeerId(peer: string, addMark?: boolean): Promise<string> {
    this.getPeerIdCalls.push({ peer, addMark });
    const failure = this.getPeerIdErrors.get(peer);
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    const id = this.peerIds.get(peer);
    if (id === undefined) {
      return Promise.reject(
        new Error(`fake client has no peer id configured for "${peer}"`),
      );
    }
    return Promise.resolve(id);
  }

  /** How many times `getPeerId` was asked to resolve a particular argument. */
  public peerIdCallCount(peer: string): number {
    return this.getPeerIdCalls.filter((call) => call.peer === peer).length;
  }
}

class FakeProvider implements DialogFilterClientProvider {
  public withClientCalls = 0;
  public readonly sessions: SessionRefValue[] = [];

  public constructor(private readonly client: DialogFilterClient) {}

  public withClient<T>(
    sessionRef: SessionRefValue,
    use: (client: DialogFilterClient) => Promise<Result<T, AppError>>,
  ): Promise<Result<T, AppError>> {
    this.withClientCalls += 1;
    this.sessions.push(sessionRef);
    return use(this.client);
  }
}

// --------------------------------------------------------------------------
// Harness + assertions
// --------------------------------------------------------------------------
interface Harness {
  readonly resolver: DialogFilterFolderResolver;
  readonly provider: FakeProvider;
  readonly client: FakeDialogFilterClient;
}

const makeHarness = (clientConfig: FakeClientConfig): Harness => {
  const client = new FakeDialogFilterClient(clientConfig);
  const provider = new FakeProvider(client);
  const resolver = new DialogFilterFolderResolver(provider);
  return { resolver, provider, client };
};

/** A canonical id that no test ever places in scope — proves "allow-list, not allow-all". */
const OUT_OF_SCOPE_ID = unwrap(ChatId.create(-987_654_321n));

const sortedKeys = (ids: readonly bigint[]): readonly string[] =>
  ids.map((id) => id.toString()).sort();

const expectOk = (result: Result<ResolvedAccess, AppError>): ResolvedScope => {
  if (isErr(result)) {
    throw new Error(
      `expected Ok ResolvedAccess, got Err ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.value.scope;
};

const expectErr = (result: Result<ResolvedAccess, AppError>): AppError => {
  if (!isErr(result)) {
    throw new Error('expected Err, got Ok ResolvedAccess');
  }
  return result.error;
};

/** Assert the resolved allow-list is EXACTLY `expected` (membership both ways + fail-closed edge). */
const expectScopeEquals = (
  scope: ResolvedScope,
  expected: readonly bigint[],
): void => {
  expect(sortedKeys(scope.toArray().map((c) => c.value))).toEqual(
    sortedKeys(expected),
  );
  expect(scope.size).toBe(expected.length);
  for (const id of expected) {
    expect(scope.contains(unwrap(ChatId.create(id)))).toBe(true);
  }
  // SECURITY (#1): the scope is an allow-list — out-of-scope peers are absent.
  expect(scope.contains(OUT_OF_SCOPE_ID)).toBe(false);
};

// ==========================================================================
describe('DialogFilterFolderResolver', () => {
  describe('folder -> peer resolution (#5)', () => {
    it('resolves a folder to its pinned ∪ included peers as canonical ChatIds', async () => {
      const { resolver, provider, client } = makeHarness({
        filters: [
          dialogFilter({
            id: 1,
            title: 'Work',
            pinned: [inputUser('111')],
            include: [inputChannel('222'), inputBasicGroup('333')],
          }),
        ],
      });

      const result = await resolver.resolve({
        sessionRef: SESSION,
        scope: scopeOf([], [folderById(1)]),
        overrides: [],
      });

      expectScopeEquals(expectOk(result), [
        userCanonical('111'),
        channelCanonical('222'),
        basicGroupCanonical('333'),
      ]);
      expect(provider.withClientCalls).toBe(1);
      expect(client.invokeCalls).toBe(1);
    });

    it('subtracts excluded peers from the folder membership', async () => {
      const { resolver } = makeHarness({
        filters: [
          dialogFilter({
            id: 1,
            title: 'Work',
            pinned: [inputUser('111'), inputUser('222')],
            include: [inputUser('333')],
            exclude: [inputUser('222')],
          }),
        ],
      });

      const scope = expectOk(
        await resolver.resolve({
          sessionRef: SESSION,
          scope: scopeOf([], [folderById(1)]),
          overrides: [],
        }),
      );

      expectScopeEquals(scope, [userCanonical('111'), userCanonical('333')]);
      // The excluded peer is genuinely absent from the enforcement boundary.
      expect(scope.contains(unwrap(ChatId.create(userCanonical('222'))))).toBe(
        false,
      );
    });

    it('ignores InputPeerEmpty entries (contributes nothing, fail-closed)', async () => {
      const { resolver } = makeHarness({
        filters: [
          dialogFilter({
            id: 1,
            title: 'Work',
            include: [inputUser('111'), inputEmpty()],
          }),
        ],
      });

      const scope = expectOk(
        await resolver.resolve({
          sessionRef: SESSION,
          scope: scopeOf([], [folderById(1)]),
          overrides: [],
        }),
      );

      expectScopeEquals(scope, [userCanonical('111')]);
    });

    it('resolves InputPeerSelf to the account id, fetched only once even across refs', async () => {
      const { resolver, client } = makeHarness({
        filters: [
          dialogFilter({
            id: 1,
            title: 'Work',
            include: [inputSelf(), inputUser('111')],
          }),
        ],
        peerIds: { me: '777000' },
      });

      const scope = expectOk(
        await resolver.resolve({
          sessionRef: SESSION,
          // both an explicit `me` chat AND a self peer inside the folder
          scope: scopeOf([meChat()], [folderById(1)]),
          overrides: [],
        }),
      );

      expectScopeEquals(scope, [userCanonical('777000'), userCanonical('111')]);
      // Self id is memoised: getPeerId('me') is called exactly once.
      expect(client.peerIdCallCount('me')).toBe(1);
    });

    it('matches a folder by its trimmed title and never matches the default "All chats"', async () => {
      const { resolver } = makeHarness({
        filters: [
          defaultFilter(),
          dialogFilter({
            id: 9,
            title: '  Work  ', // surrounding whitespace must be trimmed to match
            include: [inputChannel('500')],
          }),
        ],
      });

      const scope = expectOk(
        await resolver.resolve({
          sessionRef: SESSION,
          scope: scopeOf([], [folderByTitle('Work')]),
          overrides: [],
        }),
      );

      expectScopeEquals(scope, [channelCanonical('500')]);
    });

    it('matches a folder by its numeric filter id', async () => {
      const { resolver } = makeHarness({
        filters: [
          dialogFilter({ id: 2, title: 'A', include: [inputUser('1')] }),
          dialogFilter({ id: 7, title: 'B', include: [inputUser('888')] }),
        ],
      });

      const scope = expectOk(
        await resolver.resolve({
          sessionRef: SESSION,
          scope: scopeOf([], [folderById(7)]),
          overrides: [],
        }),
      );

      expectScopeEquals(scope, [userCanonical('888')]);
    });

    it('deduplicates a peer that appears across folders and explicit chats', async () => {
      const { resolver } = makeHarness({
        filters: [
          dialogFilter({ id: 1, title: 'A', include: [inputUser('111')] }),
          dialogFilter({ id: 2, title: 'B', pinned: [inputUser('111')] }),
        ],
      });

      const scope = expectOk(
        await resolver.resolve({
          sessionRef: SESSION,
          // explicit id 111 == the peer in both folders -> single allow-list entry
          scope: scopeOf([idChat(userCanonical('111'))], [folderById(1), folderById(2)]),
          overrides: [],
        }),
      );

      expectScopeEquals(scope, [userCanonical('111')]);
    });
  });

  describe('explicit chats are resolved INSIDE the data layer (#1, LANGUAGE FOR ARGS)', () => {
    it('resolves a pure id-only scope with ZERO MTProto requests (offline on the borrowed client)', async () => {
      const { resolver, client } = makeHarness({});

      const scope = expectOk(
        await resolver.resolve({
          sessionRef: SESSION,
          scope: scopeOf(
            [idChat(userCanonical('555')), idChat(channelCanonical('600'))],
            [],
          ),
          overrides: [],
        }),
      );

      expectScopeEquals(scope, [userCanonical('555'), channelCanonical('600')]);
      // The invariant stays cheap: id refs are already canonical — no request fires.
      expect(client.invokeCalls).toBe(0);
      expect(client.getPeerIdCalls).toHaveLength(0);
    });

    it('resolves a username chat ref via the scoped client, not the schema layer', async () => {
      const { resolver, client } = makeHarness({
        peerIds: { '@mychannel': '-1001234567890' },
      });

      const scope = expectOk(
        await resolver.resolve({
          sessionRef: SESSION,
          scope: scopeOf([usernameChat('mychannel')], []),
          overrides: [],
        }),
      );

      expectScopeEquals(scope, [BigInt('-1001234567890')]);
      // Resolved with an '@' prefix and the marked-id flag, in-layer.
      expect(client.getPeerIdCalls).toContainEqual({
        peer: '@mychannel',
        addMark: true,
      });
    });

    it('resolves a me chat ref to the account id', async () => {
      const { resolver } = makeHarness({ peerIds: { me: '777000' } });

      const scope = expectOk(
        await resolver.resolve({
          sessionRef: SESSION,
          scope: scopeOf([meChat()], []),
          overrides: [],
        }),
      );

      expectScopeEquals(scope, [userCanonical('777000')]);
    });

    it('combines explicit chats with folder-resolved peers into one allow-list', async () => {
      const { resolver } = makeHarness({
        filters: [
          dialogFilter({ id: 1, title: 'Work', include: [inputUser('111')] }),
        ],
      });

      const scope = expectOk(
        await resolver.resolve({
          sessionRef: SESSION,
          scope: scopeOf([idChat(channelCanonical('900'))], [folderById(1)]),
          overrides: [],
        }),
      );

      expectScopeEquals(scope, [
        channelCanonical('900'),
        userCanonical('111'),
      ]);
    });
  });

  describe('fail-closed (#5): never allow-all, never silently narrow', () => {
    it('rejects a folder that resolves to zero peers (no allow-all)', async () => {
      const { resolver } = makeHarness({
        filters: [dialogFilter({ id: 1, title: 'Empty' })],
      });

      const error = expectErr(
        await resolver.resolve({
          sessionRef: SESSION,
          scope: scopeOf([], [folderById(1)]),
          overrides: [],
        }),
      );

      expect(error.code).toBe(AppErrorCode.Validation);
    });

    it('rejects a folder whose every member is excluded (no allow-all)', async () => {
      const { resolver } = makeHarness({
        filters: [
          dialogFilter({
            id: 1,
            title: 'Cancelled',
            pinned: [inputUser('111')],
            exclude: [inputUser('111')],
          }),
        ],
      });

      const error = expectErr(
        await resolver.resolve({
          sessionRef: SESSION,
          scope: scopeOf([], [folderById(1)]),
          overrides: [],
        }),
      );

      expect(error.code).toBe(AppErrorCode.Validation);
    });

    it('rejects (NotFound) a folder ref that matches no dialog filter — a typo must not narrow scope', async () => {
      const { resolver } = makeHarness({
        filters: [dialogFilter({ id: 1, title: 'Work', include: [inputUser('1')] })],
      });

      const error = expectErr(
        await resolver.resolve({
          sessionRef: SESSION,
          scope: scopeOf([], [folderById(99)]),
          overrides: [],
        }),
      );

      expect(error.code).toBe(AppErrorCode.NotFound);
    });

    it('rejects (NotFound) a username that cannot be resolved within the account', async () => {
      const { resolver } = makeHarness({});

      const error = expectErr(
        await resolver.resolve({
          sessionRef: SESSION,
          scope: scopeOf([usernameChat('ghostuser')], []),
          overrides: [],
        }),
      );

      expect(error.code).toBe(AppErrorCode.NotFound);
    });
  });

  describe('no inner cache: every resolve re-resolves', () => {
    const oneFolderScope = (): Scope => scopeOf([], [folderById(1)]);
    const oneFolderConfig: FakeClientConfig = {
      filters: [dialogFilter({ id: 1, title: 'Work', include: [inputUser('111')] })],
    };

    it('loans a fresh client on every resolve (no memoisation in the resolver)', async () => {
      const { resolver, provider } = makeHarness(oneFolderConfig);

      expectScopeEquals(
        expectOk(
          await resolver.resolve({ sessionRef: SESSION, scope: oneFolderScope(), overrides: [] }),
        ),
        [userCanonical('111')],
      );
      expectOk(
        await resolver.resolve({ sessionRef: SESSION, scope: oneFolderScope(), overrides: [] }),
      );

      expect(provider.withClientCalls).toBe(2);
    });

    it('never persists a failure — the next call re-attempts and can succeed', async () => {
      const { resolver, provider } = makeHarness({
        ...oneFolderConfig,
        invokeErrors: [new Error('transient network blip')],
      });

      const first = await resolver.resolve({
        sessionRef: SESSION,
        scope: oneFolderScope(),
        overrides: [],
      });
      expect(expectErr(first).code).toBe(AppErrorCode.GatewayUnavailable);

      const second = await resolver.resolve({
        sessionRef: SESSION,
        scope: oneFolderScope(),
        overrides: [],
      });
      expectScopeEquals(expectOk(second), [userCanonical('111')]);
      expect(provider.withClientCalls).toBe(2);
    });
  });

  describe('encapsulation: GramJS errors are mapped to AppError', () => {
    const floodWait = (seconds: number): errors.FloodWaitError =>
      new errors.FloodWaitError({ request: undefined, capture: seconds });

    it('maps a FLOOD_WAIT from the dialog-filter fetch to AppError.FloodWait with retry seconds', async () => {
      const { resolver } = makeHarness({
        filters: [dialogFilter({ id: 1, title: 'Work', include: [inputUser('1')] })],
        invokeErrors: [floodWait(42)],
      });

      const error = expectErr(
        await resolver.resolve({
          sessionRef: SESSION,
          scope: scopeOf([], [folderById(1)]),
          overrides: [],
        }),
      );

      expect(error.code).toBe(AppErrorCode.FloodWait);
      expect(error.retryAfterSeconds).toBe(42);
    });

    it('maps a FLOOD_WAIT during username resolution to AppError.FloodWait', async () => {
      const { resolver } = makeHarness({
        getPeerIdErrors: { '@throttled': floodWait(30) },
      });

      const error = expectErr(
        await resolver.resolve({
          sessionRef: SESSION,
          scope: scopeOf([usernameChat('throttled')], []),
          overrides: [],
        }),
      );

      expect(error.code).toBe(AppErrorCode.FloodWait);
      expect(error.retryAfterSeconds).toBe(30);
    });

    it('maps an unexpected dialog-filter fetch failure to AppError.GatewayUnavailable', async () => {
      const { resolver } = makeHarness({
        filters: [dialogFilter({ id: 1, title: 'Work', include: [inputUser('1')] })],
        invokeErrors: [new Error('connection reset')],
      });

      const error = expectErr(
        await resolver.resolve({
          sessionRef: SESSION,
          scope: scopeOf([], [folderById(1)]),
          overrides: [],
        }),
      );

      expect(error.code).toBe(AppErrorCode.GatewayUnavailable);
    });
  });
});
