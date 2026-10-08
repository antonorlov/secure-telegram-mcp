// A fake TelegramClient for the composition-root seam: enough surface for the gateway to bind a
// real scoped client over one in-scope peer, then read and write through it.
import { Api, helpers } from 'telegram';

export interface SentMessage {
  readonly peer: unknown;
  readonly text: string;
  // How a forum topic reaches MTProto: alone it rides `replyTo` (the topic's root message),
  // and only alongside a real reply does it become `topMsgId`.
  readonly topMsgId?: number;
  readonly replyTo?: number;
}

export interface ForwardedMessages {
  readonly toPeer: unknown;
  readonly fromPeer: unknown;
  readonly messageIds: readonly number[];
}

export class FakeTelegramClient {
  public connectCalls = 0;
  public destroyCalls = 0;
  public connected = false;
  public readonly sent: SentMessage[] = [];
  public readonly forwarded: ForwardedMessages[] = [];
  public searches = 0;
  public readonly sender = {
    userDisconnected: false,
    reconnect: (): void => undefined,
    _reconnect: (): Promise<void> => Promise.resolve(),
  };
  public readonly _sender = this.sender;

  private readonly scopedIds: readonly number[];
  private readonly forumId: number | undefined;

  // The topic the fake forum carries; a message addressed elsewhere is not this one.
  public static readonly TOPIC_ID = 42;

  /**
   * Set to make the NEXT request of that kind throw instead of answering — the only way a
   * suite can exercise how a Telegram failure travels back through the daemon.
   */
  public failNextSend: Error | undefined;
  public failNextSearch: Error | undefined;
  /**
   * Holds every send inside Telegram until the suite lets it go. `sendAttempts` counts entries,
   * so a case can tell "admitted and in flight" from "not started yet" without sleeping.
   */
  public holdSends: Promise<void> | undefined;
  public sendAttempts = 0;
  /**
   * The account's one dialog folder, by the chat ids it includes. A folder is a LIVE
   * projection: what it holds when a binding is built is what the endpoint reaches.
   */
  public folder: { readonly id: number; readonly title: string; readonly chats: number[] } | undefined;
  // Newest first, the way Telegram returns history.
  public history: Api.Message[] = [];

  // Builds `count` messages with descending ids, each body produced by `text`.
  public seedHistory(count: number, text: (id: number) => string): void {
    this.history = Array.from({ length: count }, (_unused, index) => {
      const id = count - index;
      return new Api.Message({
        id,
        peerId: new Api.PeerUser({
          userId: helpers.returnBigInt(this.scopedIds[0] ?? 0),
        }),
        date: 1_700_000_000 + id,
        message: text(id),
      });
    });
  }
  /**
   * The one message `getMessages` answers with, and the bytes `downloadMedia` produces for it.
   * `declaredBytes` is what Telegram CLAIMS the document weighs — the cap is enforced against
   * the claim before a byte moves, so a case can make the two disagree.
   */
  public media:
    | {
        readonly declaredBytes: number;
        readonly body: Buffer;
        // Delivered in slices of this size, so a case can see WHERE a download stopped.
        readonly chunkBytes?: number;
      }
    | undefined;
  // Slices actually handed over on the last download.
  public downloadChunks = 0;

  /**
   * One id or several: a shared account carries every chat its endpoints are scoped to.
   * `forumChannelId` adds one forum supergroup, addressed as `-100<id>`, with a single topic —
   * enough to prove a topic id survives the whole path.
   */
  public constructor(scoped: number | readonly number[], forumChannelId?: number) {
    this.scopedIds = typeof scoped === 'number' ? [scoped] : scoped;
    this.forumId = forumChannelId;
  }

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
    readonly { entity: Api.User | Api.Channel; inputEntity: Api.TypeInputPeer }[]
  > {
    return Promise.resolve([
      ...this.scopedIds.map((id) => ({
        entity: this.user(id),
        inputEntity: this.peer(id),
      })),
      ...(this.forumId === undefined
        ? []
        : [{ entity: this.forum(this.forumId), inputEntity: this.forumPeer(this.forumId) }]),
    ]);
  }
  public async *iterDialogs(): AsyncGenerator<{
    readonly entity: Api.User | Api.Channel;
    readonly inputEntity: Api.TypeInputPeer;
    readonly unreadCount: number;
    readonly pinned: boolean;
  }> {
    await Promise.resolve();
    for (const id of this.scopedIds) {
      yield {
        entity: this.user(id),
        inputEntity: this.peer(id),
        unreadCount: 0,
        pinned: false,
      };
    }
    if (this.forumId !== undefined) {
      yield {
        entity: this.forum(this.forumId),
        inputEntity: this.forumPeer(this.forumId),
        unreadCount: 0,
        pinned: false,
      };
    }
  }
  public async sendMessage(
    peer: unknown,
    params: {
      readonly message: string;
      readonly topMsgId?: number;
      readonly replyTo?: number;
    },
  ): Promise<Api.Message> {
    this.sendAttempts += 1;
    if (this.holdSends !== undefined) await this.holdSends;
    if (this.failNextSend !== undefined) {
      const failure = this.failNextSend;
      this.failNextSend = undefined;
      throw failure;
    }
    this.sent.push({
      peer,
      text: params.message,
      ...(params.topMsgId !== undefined ? { topMsgId: params.topMsgId } : {}),
      ...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
    });
    return Promise.resolve(
      new Api.Message({
        id: 4242,
        peerId: new Api.PeerUser({
          userId: helpers.returnBigInt(this.scopedIds[0] ?? 0),
        }),
        date: 1_700_000_000,
        message: params.message,
      }),
    );
  }
  public forwardMessages(
    toPeer: unknown,
    params: { readonly messages: readonly number[]; readonly fromPeer: unknown },
  ): Promise<Api.Message[]> {
    this.forwarded.push({
      toPeer,
      fromPeer: params.fromPeer,
      messageIds: [...params.messages],
    });
    return Promise.resolve(
      params.messages.map(
        (id) =>
          new Api.Message({
            // A forward gets NEW ids on the destination; mirroring the source would hide a
            // gateway that returned the wrong side's ids.
            id: id + 1000,
            peerId: new Api.PeerUser({
              userId: helpers.returnBigInt(this.scopedIds[0] ?? 0),
            }),
            date: 1_700_000_000,
            message: '',
          }),
      ),
    );
  }

  // Phase 2 of the media flow: the gateway hands over a confined real path.
  public sendFile(
    peer: unknown,
    params: { readonly file: string; readonly caption?: string },
  ): Promise<Api.Message> {
    this.sent.push({ peer, text: params.caption ?? `file:${params.file}` });
    return Promise.resolve(
      new Api.Message({
        id: 4343,
        peerId: new Api.PeerUser({
          userId: helpers.returnBigInt(this.scopedIds[0] ?? 0),
        }),
        date: 1_700_000_000,
        message: params.caption ?? '',
      }),
    );
  }
  /**
   * Two shapes in one, as GramJS has it: `ids` fetches specific messages (the media path),
   * while `limit`/`offsetId` walks history newest-first from `this.history`.
   */
  public getMessages(
    _peer: unknown,
    params: {
      readonly ids?: readonly number[];
      readonly limit?: number;
      readonly offsetId?: number;
    },
  ): Promise<Api.Message[]> {
    if (params.ids === undefined && this.history.length > 0) {
      const from = params.offsetId ?? Number.MAX_SAFE_INTEGER;
      const page = this.history
        .filter((message) => message.id < from)
        .slice(0, params.limit ?? this.history.length);
      return Promise.resolve(page);
    }
    const media = this.media;
    if (media === undefined) return Promise.resolve([]);
    return Promise.resolve([
      new Api.Message({
        id: 77,
        peerId: new Api.PeerUser({
          userId: helpers.returnBigInt(this.scopedIds[0] ?? 0),
        }),
        date: 1_700_000_000,
        message: '',
        media: new Api.MessageMediaDocument({
          document: new Api.Document({
            id: helpers.returnBigInt(5150),
            accessHash: helpers.returnBigInt(0),
            fileReference: Buffer.alloc(0),
            date: 1_700_000_000,
            mimeType: 'text/plain',
            size: helpers.returnBigInt(media.declaredBytes),
            dcId: 2,
            attributes: [new Api.DocumentAttributeFilename({ fileName: 'note.txt' })],
            thumbs: [],
            videoThumbs: [],
          }),
        }),
      }),
    ]);
  }

  /**
   * Streams the body in slices, calling the progress hook with the running total after each —
   * the hook the gateway uses to abort a download whose declared size lied. A throw from it
   * stops the transfer, exactly as it stops GramJS's own download iterator.
   */
  public async downloadMedia(
    _message: unknown,
    params: {
      readonly outputFile: { write(chunk: Uint8Array): Promise<boolean> };
      readonly progressCallback?: (downloaded: {
        greater(value: number): boolean;
      }) => void;
    },
  ): Promise<string> {
    const body = this.media?.body ?? Buffer.alloc(0);
    const chunkBytes = this.media?.chunkBytes ?? Math.max(body.length, 1);
    this.downloadChunks = 0;
    let delivered = 0;
    while (delivered < body.length) {
      const slice = body.subarray(delivered, delivered + chunkBytes);
      await params.outputFile.write(slice);
      delivered += slice.length;
      this.downloadChunks += 1;
      params.progressCallback?.({
        greater: (value: number): boolean => delivered > value,
      });
    }
    return 'downloaded';
  }

  public invoke<R extends Api.AnyRequest>(request: R): Promise<R['__response']> {
    // An empty page: enough for the search path to complete without inventing history.
    if (request instanceof Api.messages.Search) {
      if (this.failNextSearch !== undefined) {
        const failure = this.failNextSearch;
        this.failNextSearch = undefined;
        return Promise.reject(failure);
      }
      this.searches += 1;
      return Promise.resolve(
        new Api.messages.Messages({
          messages: [],
          chats: [],
          users: [],
        }) as R['__response'],
      );
    }
    if (request instanceof Api.channels.GetForumTopics) {
      return Promise.resolve(
        new Api.messages.ForumTopics({
          count: 1,
          topics: [
            new Api.ForumTopic({
              id: FakeTelegramClient.TOPIC_ID,
              date: 1_700_000_000,
              title: 'Releases',
              iconColor: 0x6f_b9_f0,
              topMessage: 1,
              readInboxMaxId: 0,
              readOutboxMaxId: 0,
              unreadCount: 0,
              unreadMentionsCount: 0,
              unreadReactionsCount: 0,
              fromId: new Api.PeerUser({ userId: helpers.returnBigInt(7) }),
              notifySettings: new Api.PeerNotifySettings({}),
            }),
          ],
          messages: [],
          chats: [],
          users: [],
          pts: 1,
        }) as R['__response'],
      );
    }
    if (request instanceof Api.messages.GetDialogFilters) {
      const folder = this.folder;
      return Promise.resolve(
        new Api.messages.DialogFilters({
          filters:
            folder === undefined
              ? []
              : [
                  new Api.DialogFilter({
                    id: folder.id,
                    title: new Api.TextWithEntities({
                      text: folder.title,
                      entities: [],
                    }),
                    pinnedPeers: [],
                    includePeers: folder.chats.map((id) => this.peer(id)),
                    excludePeers: [],
                  }),
                ],
        }) as R['__response'],
      );
    }
    // list_dialogs refreshes metadata for the page it is about to return.
    if (request instanceof Api.messages.GetPeerDialogs) {
      return Promise.resolve(
        new Api.messages.PeerDialogs({
          dialogs: this.scopedIds.map(
            (id) =>
              new Api.Dialog({
                peer: new Api.PeerUser({ userId: helpers.returnBigInt(id) }),
                topMessage: 0,
                readInboxMaxId: 0,
                readOutboxMaxId: 0,
                unreadCount: 3,
                unreadMentionsCount: 0,
                unreadReactionsCount: 0,
                notifySettings: new Api.PeerNotifySettings({}),
              }),
          ),
          messages: [],
          chats: [],
          users: this.scopedIds.map((id) => this.user(id)),
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
  private user(id: number): Api.User {
    return new Api.User({
      id: helpers.returnBigInt(id),
      accessHash: helpers.returnBigInt(0),
      firstName: `Scoped ${String(id)}`,
    });
  }
  private forum(id: number): Api.Channel {
    return new Api.Channel({
      id: helpers.returnBigInt(id),
      accessHash: helpers.returnBigInt(0),
      title: 'Project forum',
      photo: new Api.ChatPhotoEmpty(),
      date: 1_700_000_000,
      forum: true,
      megagroup: true,
      broadcast: false,
    });
  }

  private forumPeer(id: number): Api.TypeInputPeer {
    return new Api.InputPeerChannel({
      channelId: helpers.returnBigInt(id),
      accessHash: helpers.returnBigInt(0),
    });
  }

  private peer(id: number): Api.TypeInputPeer {
    return new Api.InputPeerUser({
      userId: helpers.returnBigInt(id),
      accessHash: helpers.returnBigInt(0),
    });
  }
}
