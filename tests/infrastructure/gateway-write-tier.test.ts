/**
 * GramjsTelegramGateway WRITE TIER — the scoped adapter's send/edit/delete/
 * draft/mark-read/forward/react paths, driven through a fake TelegramClient via
 * the `clientFactory` seam (no network).
 *
 * Pinned here:
 *  - every write addresses Telegram ONLY through the scoped input handle, and
 *    the exact GramJS invocation shape (params, TL request fields) reaches the
 *    client;
 *  - an out-of-scope peer is rejected AclDenied BEFORE any client call;
 *  - forwardMessage scope-checks BOTH ends: an out-of-scope source and an
 *    out-of-scope destination are each rejected without a round-trip;
 *  - markRead's forum-topic branch requires maxMessageId and a genuine forum
 *    peer (ReadDiscussion on a non-forum would address the linked discussion
 *    group the operator never scoped);
 *  - a caller-supplied idempotency key replays the remembered result instead of
 *    sending twice;
 *  - garbage/mismatched pagination cursors are rejected Validation without a
 *    round-trip (peer, scope fan-out incl. out-of-bounds peerIndex, dialogs);
 *  - GramJS write-path throws map through the ONE shared error mapper
 *    (FORBIDDEN/BANNED -> AclDenied, TOPIC_CLOSED -> Validation, slow-mode ->
 *    FloodWait with retry seconds).
 */
import { describe, expect, it } from 'vitest';
import { Api, errors, helpers } from 'telegram';
import type { TelegramClient } from 'telegram';

import {
  AppErrorCode,
  type AppError,
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
import { mapGramjsError } from '../../src/infrastructure/telegram/gramjs-errors.js';
import { isOk, type Result } from '../../src/shared/index.js';
import { unwrap } from '../../src/shared/result.js';
import { buildEndpoint, FakeClock } from '../application/_support.js';

const USER_PEER = 101;
const SECOND_USER_PEER = 102;
const FORUM_CHANNEL_ID = 1234567890;
/** The forum supergroup in OUR canonical marked-id space. */
const FORUM_MARKED_ID = -1001234567890;
const OUT_OF_SCOPE = 999;
const MESSAGE_DATE = 1_750_000_000; // 2025-06-15T15:06:40.000Z

const idOf = (value: number): ChatId => unwrap(ChatId.create(BigInt(value)));

const peerOf = (value: number): PeerRef => PeerRefFactory.fromId(idOf(value));

/** Encode a raw cursor payload exactly as the adapter's base64url wire format. */
const rawCursor = (raw: string): string =>
  Buffer.from(raw, 'utf8').toString('base64url');

const user = (id: number): Api.User =>
  new Api.User({
    id: helpers.returnBigInt(id),
    accessHash: helpers.returnBigInt(0),
    firstName: `User ${String(id)}`,
  });

const forumChannel = (): Api.Channel =>
  new Api.Channel({
    id: helpers.returnBigInt(FORUM_CHANNEL_ID),
    accessHash: helpers.returnBigInt(0),
    title: 'Planning Forum',
    photo: new Api.ChatPhotoEmpty(),
    date: MESSAGE_DATE,
    megagroup: true,
    forum: true,
  });

const inputUser = (id: number): Api.InputPeerUser =>
  new Api.InputPeerUser({
    userId: helpers.returnBigInt(id),
    accessHash: helpers.returnBigInt(0),
  });

const inputForum = (): Api.InputPeerChannel =>
  new Api.InputPeerChannel({
    channelId: helpers.returnBigInt(FORUM_CHANNEL_ID),
    accessHash: helpers.returnBigInt(0),
  });

/**
 * GramJS types TL message-id fields as MessageIDLike; the adapter always sends
 * plain numbers, and a non-number here would fail the recorded-call assertion.
 */
const numericId = (value: unknown): number =>
  typeof value === 'number' ? value : -1;

/** Readable identity of the input handle a call actually addressed. */
const peerKey = (peer: unknown): string => {
  if (peer instanceof Api.InputPeerUser) {
    return `user:${peer.userId.toString()}`;
  }
  if (peer instanceof Api.InputPeerChannel) {
    return `channel:${peer.channelId.toString()}`;
  }
  return 'unknown';
};

const sentMessage = (id: number): Api.Message =>
  new Api.Message({
    id,
    peerId: new Api.PeerUser({ userId: helpers.returnBigInt(USER_PEER) }),
    date: MESSAGE_DATE,
    message: 'a synthetic reply body',
  });

class WriteTierTelegramClient {
  public connected = true;
  public failSendWith: Error | undefined;
  public readonly sendCalls: {
    readonly peer: string;
    readonly message: string;
    readonly replyTo?: number;
    readonly topMsgId?: number;
  }[] = [];
  public readonly editCalls: {
    readonly peer: string;
    readonly messageId: number;
    readonly text: string;
  }[] = [];
  public readonly deleteCalls: {
    readonly peer: string;
    readonly messageIds: readonly number[];
    readonly revoke: boolean | undefined;
  }[] = [];
  public readonly draftCalls: {
    readonly peer: string;
    readonly message: string;
    readonly replyToMsgId?: number;
    readonly topMsgId?: number;
  }[] = [];
  public readonly markAsReadCalls: {
    readonly peer: string;
    readonly maxId?: number;
  }[] = [];
  public readonly readDiscussionCalls: {
    readonly peer: string;
    readonly msgId: number;
    readonly readMaxId: number;
  }[] = [];
  public readonly forwardCalls: {
    readonly to: string;
    readonly from: string;
    readonly messageIds: readonly number[];
  }[] = [];
  public readonly reactionCalls: {
    readonly peer: string;
    readonly msgId: number;
    readonly emoticon: string;
  }[] = [];
  public getMessagesCalls = 0;
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
    readonly entity: Api.User | Api.Channel;
    readonly inputEntity: Api.TypeInputPeer;
    readonly unreadCount: number;
    readonly pinned: boolean;
  }> {
    await Promise.resolve();
    yield {
      entity: user(USER_PEER),
      inputEntity: inputUser(USER_PEER),
      unreadCount: 0,
      pinned: false,
    };
    yield {
      entity: user(SECOND_USER_PEER),
      inputEntity: inputUser(SECOND_USER_PEER),
      unreadCount: 0,
      pinned: false,
    };
    yield {
      entity: forumChannel(),
      inputEntity: inputForum(),
      unreadCount: 0,
      pinned: false,
    };
  }

  public getMessages(): Promise<readonly Api.Message[]> {
    this.getMessagesCalls += 1;
    return Promise.resolve([]);
  }

  public sendMessage(
    entity: unknown,
    params: {
      readonly message: string;
      readonly replyTo?: number;
      readonly topMsgId?: number;
    },
  ): Promise<Api.Message> {
    if (this.failSendWith !== undefined) {
      return Promise.reject(this.failSendWith);
    }
    this.sendCalls.push({
      peer: peerKey(entity),
      message: params.message,
      ...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
      ...(params.topMsgId !== undefined ? { topMsgId: params.topMsgId } : {}),
    });
    return Promise.resolve(sentMessage(43));
  }

  public editMessage(
    entity: unknown,
    params: { readonly message: number; readonly text: string },
  ): Promise<Api.Message> {
    this.editCalls.push({
      peer: peerKey(entity),
      messageId: params.message,
      text: params.text,
    });
    return Promise.resolve(
      new Api.Message({
        id: params.message,
        peerId: new Api.PeerUser({ userId: helpers.returnBigInt(USER_PEER) }),
        date: MESSAGE_DATE,
        editDate: MESSAGE_DATE + 100,
        message: params.text,
      }),
    );
  }

  public deleteMessages(
    entity: unknown,
    messageIds: readonly number[],
    options: { readonly revoke?: boolean },
  ): Promise<readonly Api.messages.AffectedMessages[]> {
    this.deleteCalls.push({
      peer: peerKey(entity),
      messageIds: [...messageIds],
      revoke: options.revoke,
    });
    return Promise.resolve([]);
  }

  public markAsRead(
    entity: unknown,
    _message?: unknown,
    options?: { readonly maxId?: number },
  ): Promise<boolean> {
    this.markAsReadCalls.push({
      peer: peerKey(entity),
      ...(options?.maxId !== undefined ? { maxId: options.maxId } : {}),
    });
    return Promise.resolve(true);
  }

  public forwardMessages(
    entity: unknown,
    params: { readonly messages: readonly number[]; readonly fromPeer: unknown },
  ): Promise<Api.Message[]> {
    this.forwardCalls.push({
      to: peerKey(entity),
      from: peerKey(params.fromPeer),
      messageIds: [...params.messages],
    });
    // Forwarded copies get NEW server-side ids: prove the result maps the
    // returned messages, not the requested ids.
    return Promise.resolve(params.messages.map((id) => sentMessage(id + 100)));
  }

  public invoke<R extends Api.AnyRequest>(request: R): Promise<R['__response']> {
    if (request instanceof Api.messages.SaveDraft) {
      const replyTo =
        request.replyTo instanceof Api.InputReplyToMessage
          ? request.replyTo
          : undefined;
      // GramJS types these as MessageIDLike; the adapter always passes numbers.
      const replyToMsgId =
        typeof replyTo?.replyToMsgId === 'number' ? replyTo.replyToMsgId : undefined;
      const topMsgId =
        typeof replyTo?.topMsgId === 'number' ? replyTo.topMsgId : undefined;
      this.draftCalls.push({
        peer: peerKey(request.peer),
        message: request.message,
        ...(replyToMsgId !== undefined ? { replyToMsgId } : {}),
        ...(topMsgId !== undefined ? { topMsgId } : {}),
      });
      return Promise.resolve(true as R['__response']);
    }
    if (request instanceof Api.messages.ReadDiscussion) {
      this.readDiscussionCalls.push({
        peer: peerKey(request.peer),
        msgId: numericId(request.msgId),
        readMaxId: request.readMaxId,
      });
      return Promise.resolve(true as R['__response']);
    }
    if (request instanceof Api.messages.SendReaction) {
      const first = request.reaction?.[0];
      this.reactionCalls.push({
        peer: peerKey(request.peer),
        msgId: numericId(request.msgId),
        emoticon: first instanceof Api.ReactionEmoji ? first.emoticon : '',
      });
      return Promise.resolve(
        new Api.Updates({
          updates: [],
          users: [],
          chats: [],
          date: MESSAGE_DATE,
          seq: 0,
        }) as R['__response'],
      );
    }
    return Promise.reject(new Error('unexpected request'));
  }
}

const bind = async (
  fake: WriteTierTelegramClient,
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
  const scope = unwrap(
    ResolvedScope.create([
      idOf(USER_PEER),
      idOf(SECOND_USER_PEER),
      idOf(FORUM_MARKED_ID),
    ]),
  );
  const bound = await gateway.bindScopedClient({
    endpoint: buildEndpoint({
      verbs: [
        PermissionVerb.Read,
        PermissionVerb.Send,
        PermissionVerb.Draft,
        PermissionVerb.Delete,
        PermissionVerb.MarkRead,
        PermissionVerb.Forward,
        PermissionVerb.React,
      ],
    }),
    resolvedScope: scope,
    overrides: new Map(),
  });
  expect(isOk(bound)).toBe(true);
  if (!isOk(bound)) throw new Error(bound.error.message);
  return { gateway, client: bound.value };
};

const expectOutOfScope = (result: Result<unknown, AppError>): void => {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(AppErrorCode.AclDenied);
    expect(result.error.message).toContain("outside this endpoint's scope");
  }
};

describe('Gramjs scoped write tier — sendMessage', () => {
  it('sends through the scoped input handle and reports the server message', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    const result = await client.sendMessage({
      peer: peerOf(USER_PEER),
      text: 'a synthetic outbound line',
    });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.chatId).toBe('101');
      expect(result.value.messageId).toBe(43);
      expect(result.value.dateIso).toBe('2025-06-15T15:06:40.000Z');
      expect(result.value.idempotencyKey.length).toBeGreaterThan(0);
    }
    expect(fake.sendCalls).toEqual([
      { peer: `user:${String(USER_PEER)}`, message: 'a synthetic outbound line' },
    ]);
    await gateway.dispose();
  });

  it('threads an in-topic reply as replyTo + topMsgId on the forum peer', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    const result = await client.sendMessage({
      peer: peerOf(FORUM_MARKED_ID),
      text: 'a synthetic topic reply',
      replyToMessageId: 40,
      topicId: 7,
    });

    expect(isOk(result)).toBe(true);
    expect(fake.sendCalls).toEqual([
      {
        peer: `channel:${String(FORUM_CHANNEL_ID)}`,
        message: 'a synthetic topic reply',
        replyTo: 40,
        topMsgId: 7,
      },
    ]);
    await gateway.dispose();
  });

  it('replays a remembered idempotency key instead of sending twice', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);
    const command = {
      peer: peerOf(USER_PEER),
      text: 'sent exactly once',
      idempotencyKey: 'caller-key-1',
    };

    const first = await client.sendMessage(command);
    const second = await client.sendMessage(command);

    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (isOk(first) && isOk(second)) {
      expect(second.value).toEqual(first.value);
    }
    expect(fake.sendCalls).toHaveLength(1);
    await gateway.dispose();
  });

  it('rejects an out-of-scope peer before any client call', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    expectOutOfScope(
      await client.sendMessage({ peer: peerOf(OUT_OF_SCOPE), text: 'never sent' }),
    );
    expect(fake.sendCalls).toHaveLength(0);
    await gateway.dispose();
  });
});

describe('Gramjs scoped write tier — editMessage', () => {
  it('edits by id through the scoped handle and reports the edit date', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    const result = await client.editMessage({
      peer: peerOf(USER_PEER),
      messageId: 42,
      text: 'a corrected body',
    });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.chatId).toBe('101');
      expect(result.value.messageId).toBe(42);
      expect(result.value.editedDateIso).toBe('2025-06-15T15:08:20.000Z');
    }
    expect(fake.editCalls).toEqual([
      { peer: `user:${String(USER_PEER)}`, messageId: 42, text: 'a corrected body' },
    ]);
    await gateway.dispose();
  });

  it('rejects an out-of-scope peer before any client call', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    expectOutOfScope(
      await client.editMessage({
        peer: peerOf(OUT_OF_SCOPE),
        messageId: 42,
        text: 'never edited',
      }),
    );
    expect(fake.editCalls).toHaveLength(0);
    await gateway.dispose();
  });
});

describe('Gramjs scoped write tier — deleteMessage', () => {
  it('passes the revoke flag through and echoes the deleted ids', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    const result = await client.deleteMessage({
      peer: peerOf(USER_PEER),
      messageIds: [41, 42],
      revoke: true,
    });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual({
        chatId: '101',
        deletedMessageIds: [41, 42],
        revoked: true,
      });
    }
    expect(fake.deleteCalls).toEqual([
      { peer: `user:${String(USER_PEER)}`, messageIds: [41, 42], revoke: true },
    ]);
    await gateway.dispose();
  });

  it('rejects an out-of-scope peer before any client call', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    expectOutOfScope(
      await client.deleteMessage({
        peer: peerOf(OUT_OF_SCOPE),
        messageIds: [42],
        revoke: false,
      }),
    );
    expect(fake.deleteCalls).toHaveLength(0);
    await gateway.dispose();
  });
});

describe('Gramjs scoped write tier — saveDraft', () => {
  it('saves a topic-threaded draft via SaveDraft with InputReplyToMessage', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    const result = await client.saveDraft({
      peer: peerOf(FORUM_MARKED_ID),
      text: 'a synthetic draft body',
      replyToMessageId: 9,
      topicId: 7,
    });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual({ chatId: '-1001234567890', saved: true });
    }
    expect(fake.draftCalls).toEqual([
      {
        peer: `channel:${String(FORUM_CHANNEL_ID)}`,
        message: 'a synthetic draft body',
        replyToMsgId: 9,
        topMsgId: 7,
      },
    ]);
    await gateway.dispose();
  });

  it('omits the reply header entirely for a plain draft', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    const result = await client.saveDraft({
      peer: peerOf(USER_PEER),
      text: 'plain draft',
    });

    expect(isOk(result)).toBe(true);
    expect(fake.draftCalls).toEqual([
      { peer: `user:${String(USER_PEER)}`, message: 'plain draft' },
    ]);
    await gateway.dispose();
  });

  it('rejects an out-of-scope peer before any client call', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    expectOutOfScope(
      await client.saveDraft({ peer: peerOf(OUT_OF_SCOPE), text: 'never saved' }),
    );
    expect(fake.draftCalls).toHaveLength(0);
    await gateway.dispose();
  });
});

describe('Gramjs scoped write tier — markRead', () => {
  it('marks a whole dialog read (no maxId option) and reports 0', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    const result = await client.markRead({ peer: peerOf(USER_PEER) });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual({ chatId: '101', maxReadMessageId: 0 });
    }
    expect(fake.markAsReadCalls).toEqual([{ peer: `user:${String(USER_PEER)}` }]);
    await gateway.dispose();
  });

  it('passes an explicit high-water mark as maxId', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    const result = await client.markRead({
      peer: peerOf(USER_PEER),
      maxMessageId: 50,
    });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.maxReadMessageId).toBe(50);
    }
    expect(fake.markAsReadCalls).toEqual([
      { peer: `user:${String(USER_PEER)}`, maxId: 50 },
    ]);
    await gateway.dispose();
  });

  it('marks a forum topic read via ReadDiscussion with the explicit high-water mark', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    const result = await client.markRead({
      peer: peerOf(FORUM_MARKED_ID),
      topicId: 7,
      maxMessageId: 50,
    });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual({
        chatId: '-1001234567890',
        maxReadMessageId: 50,
      });
    }
    expect(fake.readDiscussionCalls).toEqual([
      { peer: `channel:${String(FORUM_CHANNEL_ID)}`, msgId: 7, readMaxId: 50 },
    ]);
    expect(fake.markAsReadCalls).toHaveLength(0);
    await gateway.dispose();
  });

  it('refuses a topic mark-read without maxMessageId (fail-closed re-check)', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    const result = await client.markRead({
      peer: peerOf(FORUM_MARKED_ID),
      topicId: 7,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.Validation);
      expect(result.error.message).toContain('requires maxMessageId');
    }
    expect(fake.readDiscussionCalls).toHaveLength(0);
    await gateway.dispose();
  });

  it('refuses a topicId on a non-forum peer (ReadDiscussion never leaves scope)', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    const result = await client.markRead({
      peer: peerOf(USER_PEER),
      topicId: 7,
      maxMessageId: 50,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.Validation);
      expect(result.error.message).toContain('not a forum supergroup');
    }
    expect(fake.readDiscussionCalls).toHaveLength(0);
    expect(fake.markAsReadCalls).toHaveLength(0);
    await gateway.dispose();
  });

  it('rejects an out-of-scope peer before any client call', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    expectOutOfScope(await client.markRead({ peer: peerOf(OUT_OF_SCOPE) }));
    expect(fake.markAsReadCalls).toHaveLength(0);
    await gateway.dispose();
  });
});

describe('Gramjs scoped write tier — forwardMessage (both ends scope-checked)', () => {
  it('forwards between two in-scope peers and maps the RETURNED message ids', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    const result = await client.forwardMessage({
      fromPeer: peerOf(USER_PEER),
      toPeer: peerOf(SECOND_USER_PEER),
      messageIds: [11, 12],
    });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual({
        fromChatId: '101',
        toChatId: '102',
        forwardedMessageIds: [111, 112],
      });
    }
    expect(fake.forwardCalls).toEqual([
      {
        to: `user:${String(SECOND_USER_PEER)}`,
        from: `user:${String(USER_PEER)}`,
        messageIds: [11, 12],
      },
    ]);
    await gateway.dispose();
  });

  it('rejects an out-of-scope SOURCE before any client call', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    expectOutOfScope(
      await client.forwardMessage({
        fromPeer: peerOf(OUT_OF_SCOPE),
        toPeer: peerOf(USER_PEER),
        messageIds: [11],
      }),
    );
    expect(fake.forwardCalls).toHaveLength(0);
    await gateway.dispose();
  });

  it('rejects an out-of-scope DESTINATION before any client call', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    expectOutOfScope(
      await client.forwardMessage({
        fromPeer: peerOf(USER_PEER),
        toPeer: peerOf(OUT_OF_SCOPE),
        messageIds: [11],
      }),
    );
    expect(fake.forwardCalls).toHaveLength(0);
    await gateway.dispose();
  });
});

describe('Gramjs scoped write tier — sendReaction', () => {
  it('sends a single ReactionEmoji through SendReaction', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    const result = await client.sendReaction({
      peer: peerOf(USER_PEER),
      messageId: 42,
      emoji: '\u{1F44D}',
    });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual({
        chatId: '101',
        messageId: 42,
        emoji: '\u{1F44D}',
      });
    }
    expect(fake.reactionCalls).toEqual([
      { peer: `user:${String(USER_PEER)}`, msgId: 42, emoticon: '\u{1F44D}' },
    ]);
    await gateway.dispose();
  });

  it('rejects an out-of-scope peer before any client call', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    expectOutOfScope(
      await client.sendReaction({
        peer: peerOf(OUT_OF_SCOPE),
        messageId: 42,
        emoji: '\u{1F44D}',
      }),
    );
    expect(fake.reactionCalls).toHaveLength(0);
    await gateway.dispose();
  });
});

describe('Gramjs scoped reads — invalid cursors fail Validation without a round-trip', () => {
  it('getMessages rejects a garbage pagination cursor', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    const result = await client.getMessages({
      peer: peerOf(USER_PEER),
      limit: 10,
      cursor: 'garbage-cursor',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.Validation);
      expect(result.error.message).toBe('invalid pagination cursor');
    }
    expect(fake.getMessagesCalls).toBe(0);
    await gateway.dispose();
  });

  it('a peered search rejects a garbage cursor AND a scope-shaped cursor', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    for (const cursor of ['garbage-cursor', rawCursor('s:0:5')]) {
      const result = await client.searchMessages({
        query: 'q',
        peer: peerOf(USER_PEER),
        limit: 10,
        cursor,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(AppErrorCode.Validation);
        expect(result.error.message).toBe('invalid search cursor');
      }
    }
    await gateway.dispose();
  });

  it('a scope fan-out search rejects a peer-shaped cursor and an out-of-bounds peerIndex', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    // 'p:5' is the single-peer form; 's:9:0' names a 10th peer in a 3-peer scope.
    for (const cursor of [rawCursor('p:5'), rawCursor('s:9:0')]) {
      const result = await client.searchMessages({ query: 'q', limit: 10, cursor });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(AppErrorCode.Validation);
        expect(result.error.message).toBe('invalid search cursor');
      }
    }
    await gateway.dispose();
  });

  it('listDialogs rejects a garbage cursor and an offset beyond the scope', async () => {
    const fake = new WriteTierTelegramClient();
    const { gateway, client } = await bind(fake);

    for (const cursor of ['garbage-cursor', rawCursor('d:99')]) {
      const result = await client.listDialogs({ limit: 10, cursor });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(AppErrorCode.Validation);
        expect(result.error.message).toBe('invalid dialog cursor');
      }
    }
    await gateway.dispose();
  });
});

// The request argument is unused by the mapper; the cast keeps the fixture free
// of a real MTProto request object.
const NO_REQUEST = undefined as unknown as Api.AnyRequest;

describe('mapGramjsError — write-path branches', () => {
  it('maps FORBIDDEN / BANNED RPC codes to AclDenied', () => {
    for (const code of ['CHAT_WRITE_FORBIDDEN', 'USER_BANNED_IN_CHANNEL']) {
      const mapped = mapGramjsError(new errors.RPCError(code, NO_REQUEST, 403));
      expect(mapped.code).toBe(AppErrorCode.AclDenied);
      expect(mapped.message).toContain(code);
    }
  });

  it('maps a ForbiddenError instance to AclDenied', () => {
    const mapped = mapGramjsError(
      new errors.ForbiddenError('FORBIDDEN', NO_REQUEST, 403),
    );
    expect(mapped.code).toBe(AppErrorCode.AclDenied);
  });

  it('maps TOPIC_CLOSED and CHANNEL_FORUM_MISSING to Validation with named causes', () => {
    const closed = mapGramjsError(
      new errors.RPCError('TOPIC_CLOSED', NO_REQUEST, 400),
    );
    expect(closed.code).toBe(AppErrorCode.Validation);
    expect(closed.message).toBe(
      'the forum topic is closed for new messages (TOPIC_CLOSED)',
    );

    const missing = mapGramjsError(
      new errors.RPCError('CHANNEL_FORUM_MISSING', NO_REQUEST, 400),
    );
    expect(missing.code).toBe(AppErrorCode.Validation);
    expect(missing.message).toBe(
      'the chat is not a forum supergroup (CHANNEL_FORUM_MISSING)',
    );
  });

  it('maps a rejected reaction to Validation', () => {
    const mapped = mapGramjsError(
      new errors.RPCError('REACTION_INVALID', NO_REQUEST, 400),
    );
    expect(mapped.code).toBe(AppErrorCode.Validation);
    expect(mapped.message).toContain('REACTION_INVALID');
  });

  it('maps slow-mode wait to FloodWait carrying the retry seconds', () => {
    const mapped = mapGramjsError(
      new errors.SlowModeWaitError({ request: NO_REQUEST, capture: 30 }),
    );
    expect(mapped.code).toBe(AppErrorCode.FloodWait);
    expect(mapped.retryAfterSeconds).toBe(30);
  });

  it('routes a write-path throw through the mapper inside the adapter', async () => {
    const fake = new WriteTierTelegramClient();
    fake.failSendWith = new errors.RPCError('CHAT_WRITE_FORBIDDEN', NO_REQUEST, 403);
    const { gateway, client } = await bind(fake);

    const result = await client.sendMessage({
      peer: peerOf(USER_PEER),
      text: 'refused by Telegram',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.AclDenied);
      expect(result.error.message).toContain('CHAT_WRITE_FORBIDDEN');
    }
    await gateway.dispose();
  });
});
