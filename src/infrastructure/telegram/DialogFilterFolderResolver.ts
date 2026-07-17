/**
 * DialogFilterFolderResolver — the GramJS (MTProto) scope resolver, and the
 * home of the FOLDER differentiator.
 *
 * It expands a declared {@link Scope} into the canonical allow-list
 * ({@link ResolvedScope}) that becomes the enforcement boundary:
 *
 *  - FOLDER refs are resolved against the account's Telegram dialog filters
 *    (`messages.GetDialogFilters`). A folder contributes its pinned ∪ included
 *    peers, minus its explicitly excluded peers. Flag-based membership (e.g. "all
 *    groups", "all contacts") is intentionally NOT expanded: only peers a human
 *    explicitly placed in the folder are scoped (fail-closed — never widen to a
 *    whole category the operator did not enumerate).
 *  - Explicit chats: an `id` ref is already canonical; `username`/`me` refs are
 *    resolved HERE, inside the data layer — never in the schema/validation layer,
 *    which would need an unscoped resolver. A controlled, startup-time resolution
 *    used solely to BUILD the allow-list.
 *
 * FAIL-CLOSED: a scope resolving to zero canonical peers is rejected via
 * {@link ResolvedScope.create} (never an allow-all), and a folder ref matching no
 * dialog filter is a hard error (a typo must not silently narrow a scope).
 *
 * The daemon memoizes resolved contexts per endpoint (until the next policy
 * application), so this resolver just resolves afresh on every call — no inner
 * cache to invalidate.
 *
 * Encapsulation: GramJS (`telegram`) is reached ONLY through the narrow
 * {@link DialogFilterClient} and never leaks past this module. Client lifecycle
 * and credentials are owned by the injected {@link DialogFilterClientProvider}.
 */
import { Api, errors } from 'telegram';
import { type Result, ok, err, isErr } from '../../shared/index.js';
import {
  ChatId,
  ResolvedScope,
  type Scope,
  type PeerRef,
  type FolderRef,
  type SessionRefValue,
  type DeclaredChatVerbOverride,
  type PermissionVerb,
} from '../../domain/index.js';
import {
  appError,
  AppErrorCode,
  type AppError,
  type ResolveScopeInput,
  type ResolvedAccess,
} from '../../application/index.js';
import { mapGramjsError } from './gramjs-errors.js';
import { canonicalPeerIdFromInputPeer } from './telegram-peer-id.js';

/**
 * The narrow slice of a connected, UNSCOPED MTProto client this resolver needs.
 * A live GramJS `TelegramClient` satisfies this structurally; tests provide a
 * fake. Deliberately tiny — read dialog filters and resolve a peer id.
 */
export interface DialogFilterClient {
  /** Invoke a raw MTProto request (used here for `messages.GetDialogFilters`). */
  invoke<R extends Api.AnyRequest>(request: R): Promise<R['__response']>;
  /** Resolve an `@username` or `'me'` to its canonical (marked) peer id string. */
  getPeerId(peer: string, addMark?: boolean): Promise<string>;
}

/**
 * Lends a connected {@link DialogFilterClient} for the duration of `use`, then
 * releases it. The provider owns the client lifecycle, credentials and session
 * decryption, and maps connection/auth failures to an {@link AppError}.
 * Implemented by the gateway adapter / composition root.
 */
export interface DialogFilterClientProvider {
  withClient<T>(
    sessionRef: SessionRefValue,
    use: (client: DialogFilterClient) => Promise<Result<T, AppError>>,
  ): Promise<Result<T, AppError>>;
}

/** Resolves `'me'` / `InputPeerSelf` to the authenticated account's id, once. */
type SelfIdResolver = () => Promise<bigint>;

export class DialogFilterFolderResolver {
  public constructor(private readonly provider: DialogFilterClientProvider) {}

  /** Resolve afresh over a borrowed shared client; id refs issue no MTProto request. */
  public resolve(
    input: ResolveScopeInput,
  ): Promise<Result<ResolvedAccess, AppError>> {
    return this.provider.withClient(input.sessionRef, (client) =>
      resolveWithClient(client, input.scope, input.overrides),
    );
  }
}

/**
 * Resolve a scope that needs a live client (folders and/or username/me chats).
 * All GramJS calls are funnelled through one try/catch so the loaned client's
 * failures (incl. FLOOD_WAIT) become {@link AppError} rather than escaping.
 */
const resolveWithClient = async (
  client: DialogFilterClient,
  scope: Scope,
  overrides: readonly DeclaredChatVerbOverride[],
): Promise<Result<ResolvedAccess, AppError>> => {
  let selfId: bigint | undefined;
  const getSelfId: SelfIdResolver = async () => {
    selfId ??= BigInt(await client.getPeerId('me', true));
    return selfId;
  };

  // canonical-id-string -> bigint (dedupes across folders + explicit chats).
  const collected = new Map<string, bigint>();

  try {
    for (const chat of scope.chats) {
      const resolvedChat = await resolveExplicitChatId(client, chat, getSelfId);
      if (isErr(resolvedChat)) {
        return resolvedChat;
      }
      collected.set(resolvedChat.value.toString(), resolvedChat.value);
    }

    if (scope.folders.length > 0) {
      const filters = await fetchDialogFilters(client);
      for (const folderRef of scope.folders) {
        const filter = matchDialogFilter(filters, folderRef);
        if (filter === undefined) {
          return err(
            appError(
              AppErrorCode.NotFound,
              `Folder ${describeFolderRef(folderRef)} is not present in this account's dialog filters`,
            ),
          );
        }
        for (const id of await collectFilterPeerIds(filter, getSelfId)) {
          collected.set(id.toString(), id);
        }
      }
    }
    // Overrides resolve through the SAME peer machinery: each declared override
    // peer -> canonical id -> table entry. Fail-closed on any ref that does not
    // resolve (never silently drop a restriction).
    const overrideTable = new Map<string, ReadonlySet<PermissionVerb>>();
    for (const ov of overrides) {
      const id = await resolveExplicitChatId(client, ov.peer, getSelfId);
      if (isErr(id)) {
        return id;
      }
      const chatId = ChatId.create(id.value);
      if (isErr(chatId)) {
        return err(
          appError(AppErrorCode.Validation, 'Override resolved to an invalid peer id'),
        );
      }
      overrideTable.set(chatId.value.toKey(), new Set(ov.verbs));
    }

    const built = buildResolvedScope([...collected.values()]);
    if (isErr(built)) return built;
    return ok({ scope: built.value, overrides: overrideTable });
  } catch (error) {
    return err(mapGramjsError(error));
  }
};

/** Fetch the account's dialog filters (folders) via raw MTProto. */
const fetchDialogFilters = async (
  client: DialogFilterClient,
): Promise<readonly Api.TypeDialogFilter[]> => {
  const result = await client.invoke(new Api.messages.GetDialogFilters());
  return result.filters;
};

/** Find the filter a {@link FolderRef} names (the default "All chats" never matches). */
const matchDialogFilter = (
  filters: readonly Api.TypeDialogFilter[],
  ref: FolderRef,
): Api.TypeDialogFilter | undefined =>
  filters.find((filter) => {
    if (filter.className === 'DialogFilterDefault') {
      return false;
    }
    return ref.kind === 'id'
      ? filter.id === ref.id
      : filter.title.text.trim() === ref.title;
  });

/**
 * Canonical peer ids of a matched filter: pinned ∪ included, minus excluded.
 * `InputPeerSelf` entries resolve to the authenticated account via `getSelfId`;
 * empty/unknown peers contribute nothing (fail-closed).
 */
const collectFilterPeerIds = async (
  filter: Api.TypeDialogFilter,
  getSelfId: SelfIdResolver,
): Promise<readonly bigint[]> => {
  if (filter.className === 'DialogFilterDefault') {
    return [];
  }

  const excluded = new Set<string>();
  if (filter.className === 'DialogFilter') {
    for (const peer of filter.excludePeers) {
      const id = await inputPeerId(peer, getSelfId);
      if (id !== undefined) {
        excluded.add(id.toString());
      }
    }
  }

  const out: bigint[] = [];
  for (const peer of [...filter.pinnedPeers, ...filter.includePeers]) {
    const id = await inputPeerId(peer, getSelfId);
    if (id !== undefined && !excluded.has(id.toString())) {
      out.push(id);
    }
  }
  return out;
};

/** {@link canonicalPeerIdFromInputPeer}, resolving `InputPeerSelf` on demand. */
const inputPeerId = async (
  peer: Api.TypeInputPeer,
  getSelfId: SelfIdResolver,
): Promise<bigint | undefined> => {
  const direct = canonicalPeerIdFromInputPeer(peer);
  if (direct !== undefined) {
    return direct;
  }
  return peer.className === 'InputPeerSelf' ? await getSelfId() : undefined;
};

/** Resolve one explicit chat ref to a canonical id (network only for username/me). */
const resolveExplicitChatId = async (
  client: DialogFilterClient,
  chat: PeerRef,
  getSelfId: SelfIdResolver,
): Promise<Result<bigint, AppError>> => {
  switch (chat.kind) {
    case 'id':
      return ok(chat.id.value);
    case 'me':
      return ok(await getSelfId());
    case 'username':
      try {
        return ok(BigInt(await client.getPeerId(`@${chat.username}`, true)));
      } catch (error) {
        if (error instanceof errors.FloodWaitError) {
          return err(mapGramjsError(error));
        }
        return err(
          appError(
            AppErrorCode.NotFound,
            `Username @${chat.username} could not be resolved within this account`,
          ),
        );
      }
  }
};

/** Build the enforcement {@link ResolvedScope}; FAIL-CLOSED on an empty set. */
const buildResolvedScope = (
  peerIds: readonly bigint[],
): Result<ResolvedScope, AppError> => {
  const chatIds: ChatId[] = [];
  for (const value of peerIds) {
    const chatId = ChatId.create(value);
    if (isErr(chatId)) {
      return err(
        appError(
          AppErrorCode.Validation,
          `Resolved an invalid peer id (${value.toString()})`,
          { cause: chatId.error },
        ),
      );
    }
    chatIds.push(chatId.value);
  }

  const resolved = ResolvedScope.create(chatIds);
  if (isErr(resolved)) {
    return err(
      appError(AppErrorCode.Validation, resolved.error.message, {
        cause: resolved.error,
      }),
    );
  }
  return ok(resolved.value);
};

const describeFolderRef = (ref: FolderRef): string =>
  ref.kind === 'id' ? `#${String(ref.id)}` : `"${ref.title}"`;
