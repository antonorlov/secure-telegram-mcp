/**
 * GramjsAccountLoginClient — the daemon-owned, temporary adapter for one
 * interactive Telegram login.
 *
 * GramJS stays in infrastructure; prompts are callbacks supplied by the operator
 * plane and the resulting session string is persisted by the daemon.
 *
 * Security posture:
 *  - UNSCOPED by necessity, but never leaves the daemon or reaches an MCP tool.
 *  - 2FA passwords are gathered via callback, used for SRP, and NEVER persisted
 *    or logged. The session secret is returned once for the caller to
 *    encrypt-at-rest; it is never written to stdout.
 *  - Enumerated titles/usernames are attacker-controlled, so they are routed
 *    through the Sanitizer before crossing the boundary.
 *
 * Interactive prompts are injected as callbacks; the console I/O lives in the CLI.
 */
import { Api, TelegramClient, errors, sessions } from 'telegram';
import type { UnicodeSanitizer } from '../sanitize/unicode-sanitizer.js';

import { silentGramjsLogger } from './gramjs-logger.js';
import { GramjsSenderLifecycle } from './gramjs-sender-lifecycle.js';
import { mapGramjsError, rpcErrorCode } from './gramjs-errors.js';

import { AppErrorCode, appError } from '../../application/index.js';
import type { AppError } from '../../application/index.js';
import { type Result, ok, err } from '../../shared/index.js';
import {
  canonicalIdOf,
  titleOf,
  usernameOf,
} from './gramjs-mappers.js';

// ---------------------------------------------------------------------------
// Boundary DTOs — plain data, no GramJS types ever escape this module.
// ---------------------------------------------------------------------------

/** The authenticated account identity (for a friendly "logged in as …"). */
export interface LoginAccountDto {
  readonly id: string;
  readonly displayName: string;
  readonly username?: string;
}

/** Interactive callbacks for the QR login flow (mirrors the operator port). */
export interface QrLoginParams {
  /**
   * Invoked each time Telegram mints/refreshes the login token. The CLI renders
   * the `tg://login` URL as a scannable QR (and/or a headless PNG fallback).
   */
  readonly onQrCode: (info: {
    readonly url: string;
    readonly expiresInSeconds: number;
  }) => void | Promise<void>;
  /** SRP-only 2FA password provider (invoked only if the account has 2FA). */
  readonly getPassword: (hint?: string) => Promise<string>;
  /** Abort signal; aborting tears down the pending login. */
  readonly signal: AbortSignal;
}

/** Interactive callbacks for the phone-code login flow (mirrors the operator port). */
export interface PhoneLoginParams {
  readonly getPhoneNumber: () => Promise<string>;
  readonly getCode: (isCodeViaApp?: boolean) => Promise<string>;
  /** SRP-only 2FA password provider (invoked only if the account has 2FA). */
  readonly getPassword: (hint?: string) => Promise<string>;
}

export interface GramjsAccountLoginClientOptions {
  readonly apiId: number;
  readonly apiHash: string;
  /** Untrusted-content chokepoint for enumerated titles/usernames. */
  readonly sanitizer: UnicodeSanitizer;
  /** Optional NON-SECRET diagnostic sink; never receives session material. */
  readonly logger?: (message: string) => void;
  /** Lifecycle-test seam; production builds the real TelegramClient below. */
  readonly clientFactory?: () => TelegramClient;
}

const DEFAULTS = {
  connectionRetries: 5,
  floodSleepThresholdSeconds: 10,
} as const;

/** A login token rendered as the standard tg:// deep link a Telegram app scans. */
const qrLoginUrl = (token: Buffer): string =>
  `tg://login?token=${token.toString('base64url')}`;

// ---------------------------------------------------------------------------
// Login-error gate — GramJS's sign-in flows are `while(1)` loops that re-invoke
// account.GetPassword / re-prompt every iteration and only stop when our
// `onError` hook resolves `true`. Returning `false` unless aborted meant an
// UNRECOVERABLE error (e.g. `AUTH_KEY_UNREGISTERED`) spun the loop into tight
// error-spam with no re-prompt. This gate stops on abort, on a terminal error, or
// once a small attempt cap is hit (so a wrong 2FA password re-prompts a bounded
// number of times), and records the last real error so the caller can map the
// true cause (GramJS otherwise throws a generic cancel that hides it).
// ---------------------------------------------------------------------------

/** TL error codes from which retrying the sign-in loop can NEVER recover. */
const TERMINAL_LOGIN_ERRORS: ReadonlySet<string> = new Set([
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_DUPLICATED',
  'AUTH_KEY_PERM_EMPTY',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'USER_DEACTIVATED',
  'USER_DEACTIVATED_BAN',
]);

/** Total sign-in error iterations tolerated before the loop is force-stopped. */
const MAX_LOGIN_ATTEMPTS = 3;

const KNOWN_LOGIN_DIAGNOSTICS = Object.freeze([
  ...TERMINAL_LOGIN_ERRORS,
  'PASSWORD_HASH_INVALID',
  'PHONE_CODE_INVALID',
  'PHONE_CODE_EXPIRED',
]);

/** The TL error code (`RPCError.errorMessage`) or a best-effort message string. */
const loginErrorCode = (error: unknown): string =>
  error instanceof errors.RPCError
    ? error.errorMessage
    : error instanceof Error
      ? error.message
      : String(error);

/** A bounded code for logs; arbitrary exception messages never reach the sink. */
const loginErrorDiagnostic = (error: unknown): string => {
  const raw = loginErrorCode(error);
  const known = KNOWN_LOGIN_DIAGNOSTICS.find((code) => raw.includes(code));
  if (known !== undefined) return known;
  if (raw.includes('SRP_')) return 'SRP_ERROR';
  return error instanceof errors.RPCError
    ? rpcErrorCode(error.errorMessage)
    : 'NON_RPC_ERROR';
};

/**
 * True for errors the sign-in loop cannot recover from by retrying — a reset or
 * unregistered login auth key, a revoked/expired session, a deactivated account.
 * Pure; exported for tests.
 */
export const isTerminalLoginError = (error: unknown): boolean => {
  const code = loginErrorCode(error);
  for (const terminal of TERMINAL_LOGIN_ERRORS) {
    if (code.includes(terminal)) {
      return true;
    }
  }
  return false;
};

/**
 * Map a login failure to a secret-free, actionable AppError. Known classes get a
 * human message; everything else falls back to the shared {@link mapGramjsError}.
 */
const mapLoginError = (error: unknown): AppError => {
  const code = loginErrorCode(error);
  if (isTerminalLoginError(error)) {
    return appError(
      AppErrorCode.GatewayUnavailable,
      'Login session was reset or expired — scan a fresh QR code (or restart phone login) and try again.',
    );
  }
  if (code.includes('PASSWORD_HASH_INVALID') || code.includes('SRP_')) {
    return appError(
      AppErrorCode.Validation,
      'Two-step verification password is incorrect.',
    );
  }
  if (code.includes('PHONE_CODE_INVALID') || code.includes('PHONE_CODE_EXPIRED')) {
    return appError(
      AppErrorCode.Validation,
      'The login code is incorrect or has expired.',
    );
  }
  return mapGramjsError(error, 'login');
};

/** A stop-decision gate for GramJS's sign-in `onError` hook (see block above). */
export interface LoginErrorGate {
  /** GramJS keeps looping while this resolves `false`; `true` stops the loop. */
  readonly onError: (error: Error) => Promise<boolean>;
  /** The last error seen — used to map the true cause after a forced stop. */
  lastError(): unknown;
}

export const createLoginErrorGate = (opts: {
  readonly label: string;
  readonly signal?: AbortSignal;
  readonly logger?: (message: string) => void;
}): LoginErrorGate => {
  const max = MAX_LOGIN_ATTEMPTS;
  let attempts = 0;
  let last: unknown;
  return {
    lastError: (): unknown => last,
    onError: (error: Error): Promise<boolean> => {
      last = error;
      attempts += 1;
      opts.logger?.(`${opts.label} login error: ${loginErrorDiagnostic(error)}`);
      const stop =
        opts.signal?.aborted === true ||
        isTerminalLoginError(error) ||
        attempts >= max;
      return Promise.resolve(stop);
    },
  };
};

export class GramjsAccountLoginClient {
  private readonly client: TelegramClient;
  private readonly senders = new GramjsSenderLifecycle();
  private session: sessions.StringSession;
  private connected = false;
  private disposed = false;
  private connecting: Promise<Result<void, AppError>> | undefined;
  private disposing: Promise<void> | undefined;

  public constructor(private readonly options: GramjsAccountLoginClientOptions) {
    this.session = new sessions.StringSession('');
    this.client =
      options.clientFactory?.() ??
      new TelegramClient(this.session, options.apiId, options.apiHash, {
        connectionRetries: DEFAULTS.connectionRetries,
        floodSleepThreshold: DEFAULTS.floodSleepThresholdSeconds,
        // Setup is a short, operator-driven lease. An implicit reconnect can
        // outlive dispose and collide with the next menu action's client.
        autoReconnect: false,
        baseLogger: silentGramjsLogger(),
      });
    this.senders.track(this.client);
  }

  public connect(): Promise<Result<void, AppError>> {
    if (this.disposed) {
      return Promise.resolve(
        err(appError(AppErrorCode.GatewayUnavailable, 'login client disposed')),
      );
    }
    if (this.connected) {
      return Promise.resolve(ok(undefined));
    }
    this.connecting ??= this.open();
    return this.connecting;
  }

  private async open(): Promise<Result<void, AppError>> {
    try {
      await this.client.connect();
      this.senders.track(this.client);
      if (this.disposed) {
        return err(appError(AppErrorCode.GatewayUnavailable, 'login client disposed'));
      }
      this.connected = true;
      return ok(undefined);
    } catch (error) {
      return err(mapGramjsError(error, 'setup'));
    }
  }

  public async loginWithQr(
    params: QrLoginParams,
  ): Promise<Result<LoginAccountDto, AppError>> {
    const onAbort = (): void => {
      void this.dispose().catch(() => undefined);
    };
    params.signal.addEventListener('abort', onAbort, { once: true });
    const gate = createLoginErrorGate({
      label: 'qr',
      signal: params.signal,
      ...(this.options.logger !== undefined ? { logger: this.options.logger } : {}),
    });
    try {
      const user = await this.client.signInUserWithQrCode(
        { apiId: this.options.apiId, apiHash: this.options.apiHash },
        {
          qrCode: async (code) => {
            await params.onQrCode({
              url: qrLoginUrl(code.token),
              expiresInSeconds: Math.max(
                0,
                Math.round(code.expires - Date.now() / 1000),
              ),
            });
          },
          password: params.getPassword,
          onError: gate.onError,
        },
      );
      return ok(this.accountOf(user));
    } catch (error) {
      return err(mapLoginError(gate.lastError() ?? error));
    } finally {
      params.signal.removeEventListener('abort', onAbort);
    }
  }

  public async loginWithPhone(
    params: PhoneLoginParams,
  ): Promise<Result<LoginAccountDto, AppError>> {
    const gate = createLoginErrorGate({
      label: 'phone',
      ...(this.options.logger !== undefined ? { logger: this.options.logger } : {}),
    });
    try {
      const user = await this.client.signInUser(
        { apiId: this.options.apiId, apiHash: this.options.apiHash },
        {
          phoneNumber: params.getPhoneNumber,
          phoneCode: params.getCode,
          password: params.getPassword,
          onError: gate.onError,
        },
      );
      return ok(this.accountOf(user));
    } catch (error) {
      return err(mapLoginError(gate.lastError() ?? error));
    }
  }

  /** The decrypted session string to persist. NEVER log this. */
  public exportSession(): string {
    return this.session.save();
  }

  /** Tear down the temporary unscoped login client. */
  public dispose(): Promise<void> {
    this.disposed = true;
    this.senders.quiesce();
    this.disposing ??= this.teardown();
    return this.disposing;
  }

  private async teardown(): Promise<void> {
    await this.connecting;
    await this.destroyClient();
  }

  private async destroyClient(): Promise<void> {
    this.senders.track(this.client);
    this.senders.quiesce();
    await this.client.destroy();
  }

  private accountOf(user: Api.TypeUser): LoginAccountDto {
    if (!(user instanceof Api.User)) {
      return { id: '0', displayName: 'account' };
    }
    const id = canonicalIdOf(user).toString();
    const title = titleOf(user, this.options.sanitizer).sanitizedValue;
    const username = usernameOf(user);
    return {
      id,
      displayName: title,
      ...(username !== undefined ? { username } : {}),
    };
  }
}
