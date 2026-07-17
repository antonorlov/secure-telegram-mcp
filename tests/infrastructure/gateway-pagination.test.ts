import { describe, expect, it } from 'vitest';
import { Api, helpers } from 'telegram';
import type { TelegramClient } from 'telegram';

import {
  MAX_SEARCH_FANOUT_CALLS,
  type ScopedClient,
} from '../../src/application/index.js';
import {
  ChatId,
  PermissionVerb,
  PeerRefFactory,
  ResolvedScope,
  type ChatVerbOverrideTable,
} from '../../src/domain/index.js';
import {
  GramjsTelegramGateway,
  UnicodeSanitizer,
} from '../../src/infrastructure/index.js';
import { isOk } from '../../src/shared/index.js';
import { unwrap } from '../../src/shared/result.js';
import { buildEndpoint, FakeClock } from '../application/_support.js';

const idOf = (value: number): ChatId => unwrap(ChatId.create(BigInt(value)));

const inputPeer = (id: number): Api.InputPeerUser =>
  new Api.InputPeerUser({
    userId: helpers.returnBigInt(id),
    accessHash: helpers.returnBigInt(0),
  });

const user = (id: number): Api.User =>
  new Api.User({
    id: helpers.returnBigInt(id),
    accessHash: helpers.returnBigInt(0),
    firstName: `User ${String(id)}`,
  });

const message = (peerId: number, id: number): Api.Message =>
  new Api.Message({
    id,
    peerId: new Api.PeerUser({ userId: helpers.returnBigInt(peerId) }),
    date: 1_750_000_000,
    message: `peer ${String(peerId)} message ${String(id)}`,
  });

class PaginationTelegramClient {
  public connected = true;
  public iterDialogsPasses = 0;
  public getPeerDialogsCalls = 0;
  public readonly unreadByPeer = new Map<number, number>();
  public readonly pinnedByPeer = new Map<number, boolean>();
  public failSearchPeer: number | undefined;
  public readonly searchCalls: {
    readonly peerId: number;
    readonly limit: number;
    readonly offsetId?: number;
  }[] = [];
  public readonly _sender = {
    userDisconnected: false,
    reconnect: (): void => undefined,
    _reconnect: (): Promise<void> => Promise.resolve(),
  };

  public constructor(
    private readonly peerIds: readonly number[],
    private readonly messages: ReadonlyMap<number, readonly number[]>,
  ) {
    for (const id of peerIds) {
      this.unreadByPeer.set(id, id % 3);
      this.pinnedByPeer.set(id, id % 2 === 0);
    }
  }

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
    return Promise.resolve(user(7));
  }

  public async *iterDialogs(): AsyncGenerator<{
    readonly entity: Api.User;
    readonly inputEntity: Api.InputPeerUser;
    readonly unreadCount: number;
    readonly pinned: boolean;
  }> {
    await Promise.resolve();
    this.iterDialogsPasses += 1;
    for (const id of this.peerIds) {
      yield {
        entity: user(id),
        inputEntity: inputPeer(id),
        unreadCount: id % 3,
        pinned: id % 2 === 0,
      };
    }
  }

  /** Serves the gateway's raw messages.Search (offsetId 0 = "no offset"). */
  private serveSearch(request: Api.messages.Search): Promise<Api.messages.Messages> {
    if (!(request.peer instanceof Api.InputPeerUser)) {
      return Promise.reject(new Error('expected user peer'));
    }
    const peerId = Number(request.peer.userId.toString());
    const offsetId = request.offsetId === 0 ? undefined : request.offsetId;
    this.searchCalls.push({
      peerId,
      limit: request.limit,
      ...(offsetId !== undefined ? { offsetId } : {}),
    });
    if (peerId === this.failSearchPeer) {
      return Promise.reject(new Error('transient search failure'));
    }
    const ids = this.messages.get(peerId) ?? [];
    const eligible =
      offsetId === undefined ? ids : ids.filter((id) => id < offsetId);
    return Promise.resolve(
      new Api.messages.Messages({
        messages: eligible.slice(0, request.limit).map((id) => message(peerId, id)),
        chats: [],
        users: [],
      }),
    );
  }

  public invoke<R extends Api.AnyRequest>(request: R): Promise<R['__response']> {
    if (request instanceof Api.messages.Search) {
      return this.serveSearch(request);
    }
    if (!(request instanceof Api.messages.GetPeerDialogs)) {
      return Promise.reject(new Error('unexpected request'));
    }
    this.getPeerDialogsCalls += 1;
    const ids = request.peers.map((dialogPeer) => {
      if (
        !(dialogPeer instanceof Api.InputDialogPeer) ||
        !(dialogPeer.peer instanceof Api.InputPeerUser)
      ) {
        throw new Error('expected user peer');
      }
      return Number(dialogPeer.peer.userId.toString());
    });
    return Promise.resolve(
      new Api.messages.PeerDialogs({
        dialogs: ids.map(
          (id) =>
            new Api.Dialog({
              peer: new Api.PeerUser({ userId: helpers.returnBigInt(id) }),
              topMessage: 0,
              readInboxMaxId: 0,
              readOutboxMaxId: 0,
              unreadCount: this.unreadByPeer.get(id) ?? 0,
              unreadMentionsCount: 0,
              unreadReactionsCount: 0,
              notifySettings: new Api.PeerNotifySettings({}),
              pinned: this.pinnedByPeer.get(id) ?? false,
            }),
        ),
        messages: [],
        chats: [],
        users: ids.map(user),
        state: new Api.updates.State({
          pts: 0,
          qts: 0,
          date: 0,
          seq: 0,
          unreadCount: 0,
        }),
      }) as R['__response'],
    );
  }
}

const bind = async (
  fake: PaginationTelegramClient,
  peerIds: readonly number[],
  overrides: ChatVerbOverrideTable = new Map(),
): Promise<{ readonly gateway: GramjsTelegramGateway; readonly client: ScopedClient }> => {
  const gateway = new GramjsTelegramGateway({
    apiId: 1,
    apiHash: 'test-hash',
    sessionSecret: 'test-session',
    mediaRootDir: 'media',
    sanitizer: new UnicodeSanitizer(),
    clock: new FakeClock(),
    clientFactory: (): TelegramClient => fake as unknown as TelegramClient,
  });
  const scope = unwrap(ResolvedScope.create(peerIds.map(idOf)));
  const bound = await gateway.bindScopedClient({
    endpoint: buildEndpoint({ verbs: [PermissionVerb.Read] }),
    resolvedScope: scope,
    overrides,
  });
  expect(isOk(bound)).toBe(true);
  if (!isOk(bound)) throw new Error(bound.error.message);
  return { gateway, client: bound.value };
};

describe('Gramjs scoped pagination', () => {
  it('keeps binding order while refreshing one bounded dialog page', async () => {
    const fake = new PaginationTelegramClient([101, 102, 103], new Map());
    const { gateway, client } = await bind(fake, [101, 102, 103]);

    const first = await client.listDialogs({ limit: 2 });
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;
    expect(first.value.items.map((item) => item.chatId)).toEqual(['101', '102']);
    expect(first.value.items[0]?.unreadCount).toBe(2);
    expect(first.value.items[0]?.pinned).toBe(false);
    expect(first.value.nextCursor).toBeDefined();

    fake.unreadByPeer.set(101, 99);
    fake.pinnedByPeer.set(101, true);
    const refreshed = await client.listDialogs({ limit: 2 });
    expect(isOk(refreshed)).toBe(true);
    if (!isOk(refreshed)) return;
    expect(refreshed.value.items[0]?.unreadCount).toBe(99);
    expect(refreshed.value.items[0]?.pinned).toBe(true);

    const final = await client.listDialogs({
      limit: 2,
      cursor: first.value.nextCursor,
    });
    expect(isOk(final)).toBe(true);
    if (isOk(final)) {
      expect(final.value.items.map((item) => item.chatId)).toEqual(['103']);
      expect(final.value.nextCursor).toBeUndefined();
    }
    expect(fake.iterDialogsPasses).toBe(1);
    expect(fake.getPeerDialogsCalls).toBe(3);
    await gateway.dispose();
  });

  it('keeps read-narrowed dialogs out of every cached page', async () => {
    const fake = new PaginationTelegramClient([101, 102, 103], new Map());
    const overrides = new Map([
      ['102', new Set([PermissionVerb.Send])],
    ]) satisfies ChatVerbOverrideTable;
    const { gateway, client } = await bind(fake, [101, 102, 103], overrides);

    const result = await client.listDialogs({ limit: 10 });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.items.map((item) => item.chatId)).toEqual(['101', '103']);
    }
    await gateway.dispose();
  });

  it('continues a peered search from the last emitted message', async () => {
    const fake = new PaginationTelegramClient(
      [101],
      new Map([[101, [9, 8, 7]]]),
    );
    const { gateway, client } = await bind(fake, [101]);
    const peer = PeerRefFactory.fromId(idOf(101));

    const first = await client.searchMessages({ query: 'q', peer, limit: 2 });
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;
    expect(first.value.items.map((item) => item.messageId)).toEqual([9, 8]);
    expect(first.value.nextCursor).toBeDefined();

    const second = await client.searchMessages({
      query: 'q',
      peer,
      limit: 2,
      cursor: first.value.nextCursor,
    });
    expect(isOk(second)).toBe(true);
    if (isOk(second)) {
      expect(second.value.items.map((item) => item.messageId)).toEqual([7]);
      expect(second.value.nextCursor).toBeUndefined();
    }
    expect(fake.searchCalls.map((call) => call.offsetId)).toEqual([undefined, 8]);
    await gateway.dispose();
  });

  it('continues across peers without repeating or skipping hits', async () => {
    const fake = new PaginationTelegramClient(
      [101, 102],
      new Map([
        [101, [9, 8, 7]],
        [102, [6]],
      ]),
    );
    const { gateway, client } = await bind(fake, [101, 102]);

    const first = await client.searchMessages({ query: 'q', limit: 2 });
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;
    expect(first.value.items.map((item) => item.messageId)).toEqual([9, 8]);

    const second = await client.searchMessages({
      query: 'q',
      limit: 2,
      cursor: first.value.nextCursor,
    });
    expect(isOk(second)).toBe(true);
    if (isOk(second)) {
      expect(second.value.items.map((item) => item.messageId)).toEqual([7, 6]);
      expect(second.value.nextCursor).toBeUndefined();
    }
    await gateway.dispose();
  });

  it('does not advance past a peer whose search failed', async () => {
    const fake = new PaginationTelegramClient(
      [101, 102],
      new Map([[102, [6]]]),
    );
    fake.failSearchPeer = 101;
    const { gateway, client } = await bind(fake, [101, 102]);

    const result = await client.searchMessages({ query: 'q', limit: 2 });

    expect(result.ok).toBe(false);
    expect(fake.searchCalls.map(({ peerId }) => peerId)).toEqual([101]);
    await gateway.dispose();
  });

  it('stops a no-hit fan-out at the shared call budget and resumes by cursor', async () => {
    const ids = Array.from(
      { length: MAX_SEARCH_FANOUT_CALLS + 2 },
      (_, index) => 1_000 + index,
    );
    const fake = new PaginationTelegramClient(ids, new Map());
    const { gateway, client } = await bind(fake, ids);

    const first = await client.searchMessages({ query: 'none', limit: 5 });
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;
    expect(first.value.items).toEqual([]);
    expect(first.value.nextCursor).toBeDefined();
    expect(fake.searchCalls).toHaveLength(MAX_SEARCH_FANOUT_CALLS);

    const second = await client.searchMessages({
      query: 'none',
      limit: 5,
      cursor: first.value.nextCursor,
    });
    expect(isOk(second)).toBe(true);
    if (isOk(second)) expect(second.value.nextCursor).toBeUndefined();
    expect(fake.searchCalls).toHaveLength(ids.length);
    await gateway.dispose();
  });
});
