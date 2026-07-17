/**
 * Application-layer error vocabulary use-cases return to presentation. Covers
 * orchestration concerns (ACL denial, anti-ban quota, FLOOD_WAIT, gateway
 * availability, sanitization, HITL) and can wrap a DomainError. Always travels
 * inside `Result<_, AppError>`; never thrown for expected flow.
 */
import type { DomainError } from '../domain/index.js';

export const AppErrorCode = {
  /** ACL evaluation denied the request (verb or scope gate). */
  AclDenied: 'ACL_DENIED',
  /** A value failed validation before reaching the domain. */
  Validation: 'VALIDATION',
  /** Proactive anti-ban quota exhausted, independent of FLOOD_WAIT. */
  QuotaExceeded: 'QUOTA_EXCEEDED',
  /** Telegram asked us to wait (FLOOD_WAIT) — carries retry seconds. */
  FloodWait: 'FLOOD_WAIT',
  /** A human confirmation was required and not granted. */
  ConfirmationRequired: 'CONFIRMATION_REQUIRED',
  /** The peer/message/media could not be found within scope. */
  NotFound: 'NOT_FOUND',
  /** The underlying Telegram gateway/session was unavailable. */
  GatewayUnavailable: 'GATEWAY_UNAVAILABLE',
  /** A media handle was invalid/expired/foreign to this session+scope. */
  InvalidMediaHandle: 'INVALID_MEDIA_HANDLE',
  /** Output/media exceeded a size cap before entering model context. */
  SizeCapExceeded: 'SIZE_CAP_EXCEEDED',
  /**
   * The SHARED Telegram session is PIN-locked and not yet unlocked. The daemon
   * still serves initialize + tools/list while locked, but every tool CALL fails
   * closed with this code until a one-time interactive unlock. Carries only the
   * unlock-command hint (never a session string / scope / chat id / path).
   */
  SessionLocked: 'SESSION_LOCKED',
} as const;

export type AppErrorCode = (typeof AppErrorCode)[keyof typeof AppErrorCode];

export interface AppError {
  readonly code: AppErrorCode;
  readonly message: string;
  /** Retry-after seconds for FLOOD_WAIT / quota backoff. */
  readonly retryAfterSeconds?: number;
  /** The wrapped domain error, when this app error originated in the domain. */
  readonly cause?: DomainError;
}

export const appError = (
  code: AppErrorCode,
  message: string,
  extra?: {
    readonly retryAfterSeconds?: number;
    readonly cause?: DomainError;
  },
): AppError =>
  Object.freeze({
    code,
    message,
    ...(extra?.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: extra.retryAfterSeconds }
      : {}),
    ...(extra?.cause !== undefined ? { cause: extra.cause } : {}),
  });

/** Shorthand for the ubiquitous secret-free Validation error. */
export const validationError = (message: string): AppError =>
  appError(AppErrorCode.Validation, message);
