import { describe, expect, it } from 'vitest';
import type { TelegramClient } from 'telegram';

import { GramjsSenderLifecycle } from '../../src/infrastructure/telegram/gramjs-sender-lifecycle.js';

describe('GramjsSenderLifecycle retention', () => {
  it('forgets neutralized senders after their client is proven destroyed', () => {
    const sender = {
      userDisconnected: false,
      reconnect: (): void => undefined,
      _reconnect: (): Promise<void> => Promise.resolve(),
    };
    const client = {
      _sender: sender,
      _createExportedSender: (): typeof sender => sender,
    } as unknown as TelegramClient;
    const lifecycle = new GramjsSenderLifecycle();

    lifecycle.track(client);
    lifecycle.quiesceClient(client);
    lifecycle.releaseClient(client);

    const retained = (
      lifecycle as unknown as { readonly senders: ReadonlySet<unknown> }
    ).senders;
    expect(retained.size).toBe(0);
    expect(sender.userDisconnected).toBe(true);
  });
});
