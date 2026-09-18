// A fake TelegramClient for the composition-root seam: enough surface for the gateway to bind a
// real scoped client over one in-scope peer, then read and write through it.
import { Api, helpers } from 'telegram';

export interface SentMessage {
  readonly peer: unknown;
  readonly text: string;
}

export class FakeTelegramClient {
  public connectCalls = 0;
  public destroyCalls = 0;
  public connected = false;
  public readonly sent: SentMessage[] = [];
  public readonly sender = {
    userDisconnected: false,
    reconnect: (): void => undefined,
    _reconnect: (): Promise<void> => Promise.resolve(),
  };
  public readonly _sender = this.sender;

  private readonly scopedIds: readonly number[];

  // One id or several: a shared account carries every chat its endpoints are scoped to.
  public constructor(scoped: number | readonly number[]) {
    this.scopedIds = typeof scoped === 'number' ? [scoped] : scoped;
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
    readonly { entity: Api.User; inputEntity: Api.TypeInputPeer }[]
  > {
    return Promise.resolve(
      this.scopedIds.map((id) => ({
        entity: this.user(id),
        inputEntity: this.peer(id),
      })),
    );
  }
  public async *iterDialogs(): AsyncGenerator<{
    readonly entity: Api.User;
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
  }
  public sendMessage(
    peer: unknown,
    params: { readonly message: string },
  ): Promise<Api.Message> {
    this.sent.push({ peer, text: params.message });
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
  private peer(id: number): Api.TypeInputPeer {
    return new Api.InputPeerUser({
      userId: helpers.returnBigInt(id),
      accessHash: helpers.returnBigInt(0),
    });
  }
}
