/**
 * The ONE GramJS/Telegram -> AppError mapper, shared by the gateway, the folder
 * resolver, and the account-login client. Every server-controlled string embedded in a
 * model- or operator-facing error passes the `rpcErrorCode` /
 * `gatewayErrorDetail` scrub below — no adapter keeps a private, weaker copy.
 */
import { errors } from 'telegram';

import { AppErrorCode, appError } from '../../application/index.js';
import type { AppError } from '../../application/index.js';

/**
 * Telegram RPC error codes are a constrained `[A-Z0-9_]` vocabulary (e.g.
 * `PEER_ID_INVALID`, `FLOOD_WAIT_42`). Keep only that alphabet (+ length cap) so
 * a compromised server cannot smuggle hidden Cf/bidi/tag code points into the
 * model-facing error string — the one path that bypasses the UnicodeSanitizer.
 */
export const rpcErrorCode = (raw: string): string =>
  raw.replace(/[^A-Z0-9_]/g, '').slice(0, 64) || 'RPC_ERROR';

/**
 * Non-RPC gateway messages (GramJS internals, Node net/DNS errors) are not
 * covered by the RPC allow-list yet reach the model verbatim. Keep printable
 * ASCII only (no Cf/bidi/tag code points survive), hard length cap.
 */
export const gatewayErrorDetail = (raw: string): string =>
  raw.replace(/[^\x20-\x7E]/g, '').slice(0, 200) || 'unspecified error';

/**
 * Map a GramJS throw to a scrubbed `AppError`. `label` is a STATIC caller-owned
 * phrase naming the phase for the non-RPC fallbacks (e.g. 'setup', 'login');
 * it never carries server-controlled text.
 */
export const mapGramjsError = (error: unknown, label = 'gateway'): AppError => {
  if (
    error instanceof errors.FloodWaitError ||
    error instanceof errors.SlowModeWaitError
  ) {
    return appError(
      AppErrorCode.FloodWait,
      `Telegram FLOOD_WAIT for ${String(error.seconds)}s`,
      { retryAfterSeconds: error.seconds },
    );
  }
  if (error instanceof errors.FloodError) {
    return appError(AppErrorCode.FloodWait, 'Telegram flood limit reached');
  }
  if (error instanceof errors.RPCError) {
    const detail = rpcErrorCode(error.errorMessage);
    if (
      /NOT_FOUND|PEER_ID_INVALID|MSG_ID_INVALID|MESSAGE_ID_INVALID|CHANNEL_INVALID|USER_NOT_PARTICIPANT|TOPIC_DELETED/.test(
        detail,
      )
    ) {
      return appError(
        AppErrorCode.NotFound,
        `Telegram could not find the target (${detail})`,
      );
    }
    if (/TOPIC_CLOSED|CHANNEL_FORUM_MISSING/.test(detail)) {
      return appError(
        AppErrorCode.Validation,
        detail === 'TOPIC_CLOSED'
          ? 'the forum topic is closed for new messages (TOPIC_CLOSED)'
          : 'the chat is not a forum supergroup (CHANNEL_FORUM_MISSING)',
      );
    }
    if (/REACTION_INVALID|REACTION_EMPTY|REACTIONS_TOO_MANY/.test(detail)) {
      return appError(
        AppErrorCode.Validation,
        `the reaction was rejected by Telegram (${detail})`,
      );
    }
    if (error instanceof errors.ForbiddenError || /FORBIDDEN|BANNED/.test(detail)) {
      return appError(
        AppErrorCode.AclDenied,
        `Telegram refused the operation (${detail})`,
      );
    }
    return appError(
      AppErrorCode.GatewayUnavailable,
      `Telegram RPC error (${detail})`,
    );
  }
  if (error instanceof Error) {
    return appError(
      AppErrorCode.GatewayUnavailable,
      `Telegram ${label} error: ${gatewayErrorDetail(error.message)}`,
    );
  }
  return appError(AppErrorCode.GatewayUnavailable, `Unknown Telegram ${label} error`);
};
