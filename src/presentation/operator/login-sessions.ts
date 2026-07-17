import {
  AppErrorCode,
  appError,
  type AppError,
  type SessionAdmin,
  type SessionKeySource,
} from '../../application/index.js';
import type { SessionRefValue } from '../../domain/index.js';
import { err, isErr, ok, type Result } from '../../shared/index.js';

interface LoginAccount {
  readonly id: string;
  readonly displayName: string;
  readonly username?: string;
}

export interface OperatorLoginClient {
  connect(): Promise<Result<void, AppError>>;
  loginWithQr(input: {
    readonly onQrCode: (info: {
      readonly url: string;
      readonly expiresInSeconds: number;
    }) => void | Promise<void>;
    readonly getPassword: (hint?: string) => Promise<string>;
    readonly signal: AbortSignal;
  }): Promise<Result<LoginAccount, AppError>>;
  loginWithPhone(input: {
    readonly getPhoneNumber: () => Promise<string>;
    readonly getCode: (isCodeViaApp?: boolean) => Promise<string>;
    readonly getPassword: (hint?: string) => Promise<string>;
  }): Promise<Result<LoginAccount, AppError>>;
  exportSession(): string;
  dispose(): Promise<void>;
}

export interface LoginInteraction {
  readonly signal: AbortSignal;
  qr(info: {
    readonly url: string;
    readonly expiresInSeconds: number;
  }): Promise<void>;
  ask(
    kind: 'phone' | 'code' | 'password',
    hint?: string,
  ): Promise<string>;
}

interface PendingLogin {
  readonly client: OperatorLoginClient;
  readonly apiId: number;
  readonly apiHash: string;
  readonly account: LoginAccount;
}

interface LoginStore extends SessionAdmin {
  appPosture(): Promise<'none' | 'smooth' | 'hardened'>;
  setActiveSource(source: SessionKeySource): void;
}

const keyOf = (ownerId: string, flowId: string): string => `${ownerId}:${flowId}`;

/** Temporary unscoped login capabilities, owned and cleaned up per operator socket. */
export class OperatorLoginSessions {
  private readonly pending = new Map<string, PendingLogin>();
  private readonly clients = new Set<OperatorLoginClient>();
  private readonly disposing = new Map<OperatorLoginClient, Promise<void>>();

  public constructor(
    private readonly store: LoginStore,
    private readonly createClient: (input: {
      readonly apiId: number;
      readonly apiHash: string;
    }) => OperatorLoginClient,
    private readonly mutateAccount: <T>(
      sessionRef: string,
      work: () => Promise<Result<T, AppError>>,
    ) => Promise<Result<T, AppError>>,
  ) {}

  public async begin(
    ownerId: string,
    flowId: string,
    input: {
      readonly apiId: number;
      readonly apiHash: string;
      readonly method: 'qr' | 'phone';
    },
    interaction: LoginInteraction,
  ): Promise<Result<{ readonly flowId: string; readonly account: LoginAccount }, AppError>> {
    const key = keyOf(ownerId, flowId);
    if (this.pending.has(key)) {
      return err(appError(AppErrorCode.Validation, 'login flow already exists'));
    }
    const client = this.createClient(input);
    this.clients.add(client);
    const abort = (): void => {
      void this.disposeClient(client).catch(() => undefined);
    };
    interaction.signal.addEventListener('abort', abort, { once: true });
    try {
      const connected = await client.connect();
      if (isErr(connected)) return connected;
      const account =
        input.method === 'qr'
          ? await client.loginWithQr({
              onQrCode: (info) => interaction.qr(info),
              getPassword: (hint) => interaction.ask('password', hint),
              signal: interaction.signal,
            })
          : await client.loginWithPhone({
              getPhoneNumber: () => interaction.ask('phone'),
              getCode: () => interaction.ask('code'),
              getPassword: (hint) => interaction.ask('password', hint),
            });
      if (isErr(account)) return account;
      // Disconnect may win while the Telegram login promise is settling. Publish
      // only to a live owner; cancelOwner already ran and cannot see a later entry.
      if (interaction.signal.aborted) {
        return err(appError(AppErrorCode.GatewayUnavailable, 'login owner disconnected'));
      }
      this.pending.set(key, {
        client,
        apiId: input.apiId,
        apiHash: input.apiHash,
        account: account.value,
      });
      return ok({ flowId, account: account.value });
    } finally {
      interaction.signal.removeEventListener('abort', abort);
      if (!this.pending.has(key)) await this.disposeClient(client);
    }
  }

  public async commit(
    ownerId: string,
    flowId: string,
    sessionRef: SessionRefValue,
    source: SessionKeySource,
  ): Promise<Result<{ readonly sessionRef: string }, AppError>> {
    const key = keyOf(ownerId, flowId);
    const login = this.pending.get(key);
    if (login === undefined) {
      return err(appError(AppErrorCode.NotFound, 'login flow is not available'));
    }
    const firstWrite = (await this.store.appPosture()) === 'none';
    if (firstWrite) {
      this.store.setActiveSource(source);
    }
    try {
      const secret = login.client.exportSession();
      const committed = await this.mutateAccount(String(sessionRef), async () => {
        this.pending.delete(key);
        try {
          await this.disposeClient(login.client);
        } catch {
          return err(
            appError(
              AppErrorCode.GatewayUnavailable,
              'login connection did not close cleanly',
            ),
          );
        }
        const saved = await this.store.save({
          sessionRef,
          secret,
          apiId: login.apiId,
          apiHash: login.apiHash,
          label: login.account.displayName,
        });
        return isErr(saved)
          ? saved
          : ok({ sessionRef: String(sessionRef) });
      });
      if (firstWrite && isErr(committed)) {
        this.store.setActiveSource({ kind: 'machine' });
      }
      if (isErr(committed)) await this.cancel(ownerId, flowId);
      return committed;
    } catch {
      if (firstWrite) this.store.setActiveSource({ kind: 'machine' });
      await this.cancel(ownerId, flowId);
      return err(
        appError(
          AppErrorCode.GatewayUnavailable,
          'could not commit the Telegram account safely',
        ),
      );
    }
  }

  public async cancel(ownerId: string, flowId: string): Promise<void> {
    const key = keyOf(ownerId, flowId);
    const login = this.pending.get(key);
    this.pending.delete(key);
    if (login !== undefined) await this.disposeClient(login.client);
  }

  public async cancelOwner(ownerId: string): Promise<void> {
    const flows = [...this.pending.keys()].filter((key) =>
      key.startsWith(`${ownerId}:`),
    );
    await Promise.all(
      flows.map((key) => this.cancel(ownerId, key.slice(ownerId.length + 1))),
    );
  }

  public async disposeAll(): Promise<void> {
    this.pending.clear();
    const settled = await Promise.allSettled(
      [...this.clients].map((client) => this.disposeClient(client)),
    );
    const failed = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed !== undefined) throw failed.reason;
  }

  /** Memoize concurrent teardown; retain failed ownership for shutdown reporting. */
  private disposeClient(client: OperatorLoginClient): Promise<void> {
    const existing = this.disposing.get(client);
    if (existing !== undefined) return existing;
    const disposing = client.dispose().then(
      () => {
        this.clients.delete(client);
        this.disposing.delete(client);
      },
      (error: unknown) => {
        this.disposing.delete(client);
        throw error;
      },
    );
    this.disposing.set(client, disposing);
    return disposing;
  }
}
