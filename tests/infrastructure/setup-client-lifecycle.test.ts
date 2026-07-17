/** The temporary account-login client must release its auth key before reuse. */
import { describe, expect, it } from 'vitest';
import type { TelegramClient } from 'telegram';

import { GramjsAccountLoginClient } from '../../src/infrastructure/telegram/gramjs-account-login-client.js';
import {
  UnicodeSanitizer,
} from '../../src/infrastructure/index.js';
import { isErr } from '../../src/shared/index.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class FakeSetupTelegramClient {
  public destroyCalls = 0;
  public reconnectCalls = 0;
  public exportedReconnectCalls = 0;
  public failDestroy = false;
  private finishConnect: (() => void) | undefined;
  private readonly connectGate = new Promise<void>((resolve) => {
    this.finishConnect = resolve;
  });
  public readonly sender = {
    userDisconnected: false,
    reconnect: (): void => {
      this.reconnectCalls += 1;
    },
    _reconnect: (): Promise<void> => {
      this.reconnectCalls += 1;
      return Promise.resolve();
    },
  };
  public readonly exportedSender = {
    userDisconnected: false,
    reconnect: (): void => {
      this.exportedReconnectCalls += 1;
    },
    _reconnect: (): Promise<void> => {
      this.exportedReconnectCalls += 1;
      return Promise.resolve();
    },
  };
  public readonly _sender = this.sender;

  public connect(): Promise<void> {
    return this.connectGate;
  }

  public releaseConnect(): void {
    this.finishConnect?.();
  }

  public _createExportedSender(): typeof this.exportedSender {
    return this.exportedSender;
  }

  public destroy(): Promise<void> {
    this.destroyCalls += 1;
    return this.failDestroy
      ? Promise.reject(new Error('destroy failed'))
      : Promise.resolve();
  }
}

const build = (fake: FakeSetupTelegramClient): GramjsAccountLoginClient =>
  new GramjsAccountLoginClient({
    apiId: 1,
    apiHash: 'test-hash',
    sanitizer: new UnicodeSanitizer(),
    clientFactory: () => fake as unknown as TelegramClient,
  });

describe('GramjsAccountLoginClient lifecycle', () => {
  it('quiesces main and exported reconnect callbacks before destroy', async () => {
    const fake = new FakeSetupTelegramClient();
    const client = build(fake);
    fake._createExportedSender();

    await client.dispose();
    fake.sender.reconnect();
    await fake.sender._reconnect();
    fake.exportedSender.reconnect();
    await fake.exportedSender._reconnect();

    expect(fake.sender.userDisconnected).toBe(true);
    expect(fake.exportedSender.userDisconnected).toBe(true);
    expect(fake.reconnectCalls).toBe(0);
    expect(fake.exportedReconnectCalls).toBe(0);
    expect(fake.destroyCalls).toBe(1);
  });

  it('does not resolve disposal while connect is still in flight', async () => {
    const fake = new FakeSetupTelegramClient();
    const client = build(fake);
    const connecting = client.connect();
    await settle();

    let disposed = false;
    const disposing = client.dispose().then(() => {
      disposed = true;
    });
    await settle();
    expect(disposed).toBe(false);
    expect(fake.destroyCalls).toBe(0);

    fake.releaseConnect();
    expect(isErr(await connecting)).toBe(true);
    await disposing;
    expect(disposed).toBe(true);
    expect(fake.destroyCalls).toBe(1);
  });

  it('shares one teardown across concurrent disposal callers', async () => {
    const fake = new FakeSetupTelegramClient();
    const client = build(fake);

    const first = client.dispose();
    const second = client.dispose();

    expect(second).toBe(first);
    await first;
    expect(fake.destroyCalls).toBe(1);
  });

  it('propagates final destroy failure after quiescing reconnects', async () => {
    const fake = new FakeSetupTelegramClient();
    fake.failDestroy = true;
    const client = build(fake);

    await expect(client.dispose()).rejects.toThrow('destroy failed');

    expect(fake.sender.userDisconnected).toBe(true);
    expect(fake.destroyCalls).toBe(1);
  });
});
