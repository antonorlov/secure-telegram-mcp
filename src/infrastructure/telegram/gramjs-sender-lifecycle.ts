import type { TelegramClient } from 'telegram';

type GramjsSender = NonNullable<TelegramClient['_sender']>;

/**
 * Tracks every sender a GramJS client creates, including exported-DC senders.
 * The owner may route implicit reconnects through one controller; teardown can
 * then synchronously neutralize every queued reconnect before destroy().
 */
export class GramjsSenderLifecycle {
  private readonly senders = new Set<GramjsSender>();
  private readonly clients = new WeakSet<TelegramClient>();
  private readonly clientSenders = new WeakMap<TelegramClient, Set<GramjsSender>>();
  private quiesced = false;

  public constructor(
    private readonly reconnect?: (client: TelegramClient) => Promise<void>,
  ) {}

  public track(client: TelegramClient): void {
    this.trackSender(client._sender, client);
    if (this.clients.has(client)) {
      return;
    }
    this.clients.add(client);
    const createSender = client._createExportedSender.bind(client);
    client._createExportedSender = (dcId: number): GramjsSender => {
      const sender = createSender(dcId);
      this.trackSender(sender, client);
      return sender;
    };
  }

  public quiesce(): void {
    this.quiesced = true;
    for (const sender of this.senders) {
      this.neutralize(sender);
    }
  }

  /** Neutralize one failed/aborted client without retiring future clients. */
  public quiesceClient(client: TelegramClient): void {
    for (const sender of this.clientSenders.get(client) ?? []) {
      this.neutralize(sender);
    }
  }

  /** Forget every neutralized sender after its client was proven destroyed. */
  public releaseClient(client: TelegramClient): void {
    const owned = this.clientSenders.get(client);
    if (owned !== undefined) {
      for (const sender of owned) this.senders.delete(sender);
      this.clientSenders.delete(client);
    }
    this.clients.delete(client);
  }

  private trackSender(
    sender: GramjsSender | undefined,
    client: TelegramClient,
  ): void {
    if (sender === undefined || this.senders.has(sender)) {
      return;
    }
    this.senders.add(sender);
    const clientSet = this.clientSenders.get(client) ?? new Set<GramjsSender>();
    clientSet.add(sender);
    this.clientSenders.set(client, clientSet);
    if (this.quiesced) {
      this.neutralize(sender);
      return;
    }
    if (this.reconnect === undefined) {
      return;
    }
    const reconnect = (): Promise<void> => this.reconnect?.(client) ?? Promise.resolve();
    sender.reconnect = (): void => {
      void reconnect();
    };
    sender._reconnect = reconnect;
  }

  private neutralize(sender: GramjsSender): void {
    sender.userDisconnected = true;
    sender.reconnect = (): void => undefined;
    sender._reconnect = (): Promise<void> => Promise.resolve();
  }
}
