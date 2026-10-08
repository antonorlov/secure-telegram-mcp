// Always travels inside `Result<_, AppError>`; never thrown for expected flow.
import type { DomainError } from '../domain/index.js';

export const AppErrorCode = {
  AclDenied: 'ACL_DENIED',
  Validation: 'VALIDATION',
  QuotaExceeded: 'QUOTA_EXCEEDED',
  FloodWait: 'FLOOD_WAIT',
  ConfirmationRequired: 'CONFIRMATION_REQUIRED',
  NotFound: 'NOT_FOUND',
  GatewayUnavailable: 'GATEWAY_UNAVAILABLE',
  InvalidMediaHandle: 'INVALID_MEDIA_HANDLE',
  SizeCapExceeded: 'SIZE_CAP_EXCEEDED',
  /**
   * The daemon still serves initialize and tools/list while locked; every tool call fails
   * closed with this code until a one-time interactive unlock. Carries only the unlock hint —
   * never a session string, scope, chat id or path.
   */
  SessionLocked: 'SESSION_LOCKED',
} as const;

export type AppErrorCode = (typeof AppErrorCode)[keyof typeof AppErrorCode];

export interface AppError {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly retryAfterSeconds?: number;
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

export const validationError = (message: string): AppError =>
  appError(AppErrorCode.Validation, message);
