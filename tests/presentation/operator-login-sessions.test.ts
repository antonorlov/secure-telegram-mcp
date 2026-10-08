import { describe, expect, it } from 'vitest';

import {
  AppErrorCode,
  appError,
  type AddKekInput,
  type AppError,
  type EmitRecoveryKeyfileInput,
  type RemoveKekInput,
  type RewrapKekInput,
  type SessionAdmin,
  type SessionKeySource,
  type SessionMaterial,
} from '../../src/application/index.js';
import { SessionRef } from '../../src/domain/index.js';
import {
  OperatorLoginSessions,
  type LoginInteraction,
  type OperatorLoginClient,
} from '../../src/presentation/operator/login-sessions.js';
import { err, ok, type Result } from '../../src/shared/index.js';
import { unwrap } from '../../src/shared/result.js';

const SOURCE: SessionKeySource = {
  kind: 'passphrase',
  passphrase: 'correct-horse',
};

class FakeLoginStore implements SessionAdmin {
  public readonly order: string[] = [];
  public posture: 'none' | 'smooth' | 'hardened' = 'none';
  public saved: SessionMaterial | undefined;

  public appPosture(): Promise<typeof this.posture> {
    return Promise.resolve(this.posture);
  }

  public setActiveSource(source: SessionKeySource): void {
    this.order.push(`source:${source.kind}`);
  }

  public save(material: SessionMaterial): Promise<Result<void, AppError>> {
    this.order.push('save');
    this.saved = material;
    return Promise.resolve(ok(undefined));
  }

  public addKek(_input: AddKekInput): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  public rewrapKek(_input: RewrapKekInput): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  public removeKek(_input: RemoveKekInput): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }

  public emitRecoveryKeyfile(
    _input: EmitRecoveryKeyfileInput,
  ): Promise<Result<void, AppError>> {
    return Promise.resolve(ok(undefined));
  }
}

class FakeLoginClient implements OperatorLoginClient {
  public readonly order: string[] = [];
  public exportError: Error | undefined;
  public disposeError: Error | undefined;
  public emitQr = false;
  public loginResult: Result<
    { readonly id: string; readonly displayName: string },
    AppError
  > = ok({ id: '42', displayName: 'Test Account' });

  public connect(): Promise<Result<void, AppError>> {
    this.order.push('connect');
    return Promise.resolve(ok(undefined));
  }

  public async loginWithQr(
    input: Parameters<OperatorLoginClient['loginWithQr']>[0],
  ): Promise<typeof this.loginResult> {
    this.order.push('login');
    if (this.emitQr) {
      await input.onQrCode({ url: 'tg://login', expiresInSeconds: 60 });
    }
    return this.loginResult;
  }

  public loginWithPhone(): Promise<typeof this.loginResult> {
    this.order.push('login');
    return Promise.resolve(this.loginResult);
  }

  public exportSession(): string {
    this.order.push('export');
    if (this.exportError !== undefined) throw this.exportError;
    return 'SESSION_SECRET';
  }

  public dispose(): Promise<void> {
    this.order.push('dispose');
    return this.disposeError === undefined
      ? Promise.resolve()
      : Promise.reject(this.disposeError);
  }
}

const interaction = (): LoginInteraction => ({
  signal: new AbortController().signal,
  qr: () => Promise.resolve(),
  ask: () => Promise.resolve('answer'),
});

describe('OperatorLoginSessions', () => {
  it('waits for QR delivery before completing login', async () => {
    const store = new FakeLoginStore();
    const client = new FakeLoginClient();
    client.emitQr = true;
    let qrStarted!: () => void;
    const started = new Promise<void>((resolve) => { qrStarted = resolve; });
    let deliverQr!: () => void;
    const delivered = new Promise<void>((resolve) => { deliverQr = resolve; });
    const sessions = new OperatorLoginSessions(
      store,
      () => client,
      (_sessionRef, work) => work(),
    );

    let settled = false;
    const beginning = sessions.begin(
      'owner',
      'flow',
      { apiId: 123, apiHash: 'a'.repeat(32), method: 'qr' },
      {
        ...interaction(),
        qr: async () => {
          qrStarted();
          await delivered;
        },
      },
    ).then((result) => {
      settled = true;
      return result;
    });
    await started;
    await Promise.resolve();
    expect(settled).toBe(false);

    deliverQr();
    expect((await beginning).ok).toBe(true);
    await sessions.disposeAll();
  });

  it('retires the old account and closes login before commit resolves', async () => {
    const store = new FakeLoginStore();
    const client = new FakeLoginClient();
    const order = store.order;
    const sessions = new OperatorLoginSessions(
      store,
      () => client,
      async (_sessionRef, work) => {
        order.push('retire');
        return await work();
      },
    );
    const begun = await sessions.begin(
      'owner',
      'flow',
      { apiId: 123, apiHash: 'a'.repeat(32), method: 'phone' },
      interaction(),
    );
    expect(begun.ok).toBe(true);

    const committed = await sessions.commit(
      'owner',
      'flow',
      unwrap(SessionRef.create('main')),
      SOURCE,
    );

    expect(committed).toEqual(ok({ sessionRef: 'main' }));
    expect(order).toEqual(['source:passphrase', 'retire', 'save']);
    expect(client.order).toEqual(['connect', 'login', 'export', 'dispose']);
    expect(store.saved).toMatchObject({
      secret: 'SESSION_SECRET',
      apiId: 123,
      apiHash: 'a'.repeat(32),
      label: 'Test Account',
    });
  });

  it('disposes a failed login and never makes it committable', async () => {
    const store = new FakeLoginStore();
    const client = new FakeLoginClient();
    client.loginResult = err(
      appError(AppErrorCode.GatewayUnavailable, 'login failed'),
    );
    const sessions = new OperatorLoginSessions(
      store,
      () => client,
      (_sessionRef, work) => work(),
    );

    expect(
      (
        await sessions.begin(
          'owner',
          'flow',
          { apiId: 123, apiHash: 'a'.repeat(32), method: 'qr' },
          interaction(),
        )
      ).ok,
    ).toBe(false);
    expect(client.order).toEqual(['connect', 'login', 'dispose']);
    expect(
      (
        await sessions.commit(
          'owner',
          'flow',
          unwrap(SessionRef.create('main')),
          SOURCE,
        )
      ).ok,
    ).toBe(false);
  });

  it('rolls back first-write key state and disposes when export fails', async () => {
    const store = new FakeLoginStore();
    const client = new FakeLoginClient();
    client.exportError = new Error('export failed');
    const sessions = new OperatorLoginSessions(
      store,
      () => client,
      (_sessionRef, work) => work(),
    );
    await sessions.begin(
      'owner',
      'flow',
      { apiId: 123, apiHash: 'a'.repeat(32), method: 'phone' },
      interaction(),
    );

    const committed = await sessions.commit(
      'owner',
      'flow',
      unwrap(SessionRef.create('main')),
      SOURCE,
    );

    expect(committed.ok).toBe(false);
    expect(store.order).toEqual(['source:passphrase', 'source:machine']);
    expect(client.order).toEqual(['connect', 'login', 'export', 'dispose']);
    expect(store.saved).toBeUndefined();
  });

  it('cancels every pending login owned by a disconnected socket', async () => {
    const store = new FakeLoginStore();
    const first = new FakeLoginClient();
    const second = new FakeLoginClient();
    const clients = [first, second];
    const sessions = new OperatorLoginSessions(
      store,
      () => clients.shift() ?? new FakeLoginClient(),
      (_sessionRef, work) => work(),
    );
    await sessions.begin(
      'owner',
      'one',
      { apiId: 1, apiHash: 'a'.repeat(32), method: 'phone' },
      interaction(),
    );
    await sessions.begin(
      'owner',
      'two',
      { apiId: 2, apiHash: 'b'.repeat(32), method: 'phone' },
      interaction(),
    );

    await sessions.cancelOwner('owner');

    expect(first.order).toEqual(['connect', 'login', 'dispose']);
    expect(second.order).toEqual(['connect', 'login', 'dispose']);
  });

  it('does not publish a login that settles after its owner disconnects', async () => {
    let settleLogin!: () => void;
    const loginSettled = new Promise<void>((resolve) => {
      settleLogin = resolve;
    });
    const store = new FakeLoginStore();
    const client = new FakeLoginClient();
    client.loginWithPhone = async (): Promise<typeof client.loginResult> => {
      client.order.push('login');
      await loginSettled;
      return client.loginResult;
    };
    const sessions = new OperatorLoginSessions(
      store,
      () => client,
      (_sessionRef, work) => work(),
    );
    const abort = new AbortController();
    const begun = sessions.begin(
      'owner',
      'flow',
      { apiId: 1, apiHash: 'a'.repeat(32), method: 'phone' },
      {
        ...interaction(),
        signal: abort.signal,
      },
    );

    await Promise.resolve();
    abort.abort();
    await sessions.cancelOwner('owner');
    settleLogin();

    expect((await begun).ok).toBe(false);
    expect(client.order).toContain('dispose');
    expect(
      (
        await sessions.commit(
          'owner',
          'flow',
          unwrap(SessionRef.create('main')),
          SOURCE,
        )
      ).ok,
    ).toBe(false);
  });

  it('retains failed teardown ownership so shutdown can retry and observe it', async () => {
    const client = new FakeLoginClient();
    const sessions = new OperatorLoginSessions(
      new FakeLoginStore(),
      () => client,
      (_sessionRef, work) => work(),
    );
    await sessions.begin(
      'owner',
      'flow',
      { apiId: 1, apiHash: 'a'.repeat(32), method: 'phone' },
      interaction(),
    );
    client.disposeError = new Error('destroy failed');

    await expect(sessions.cancel('owner', 'flow')).rejects.toThrow(
      'destroy failed',
    );
    client.disposeError = undefined;
    await expect(sessions.disposeAll()).resolves.toBeUndefined();
    expect(client.order.filter((entry) => entry === 'dispose')).toHaveLength(2);
  });
});
