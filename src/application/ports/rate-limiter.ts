/**
 * RateLimiter — PROACTIVE anti-ban quota per endpoint, INDEPENDENT of Telegram's
 * FLOOD_WAIT. Separate buckets for messages/min, forwards/min and
 * searches/min. `tryConsume` atomically reserves quota and tells the caller
 * whether to proceed; on refusal it reports retry-after.
 */
import type { Result } from '../../shared/index.js';
import type { EndpointNameValue, SessionRefValue } from '../../domain/index.js';
import type { AppError } from '../errors.js';

/** The distinct anti-ban buckets an operation may draw from. */
export const QuotaBucket = {
  Messages: 'messages',
  Forwards: 'forwards',
  /**
   * READ-side bucket: MTProto search calls. An un-peered `search_messages` fans
   * out into one search per in-scope chat, so it reserves `units` equal to the
   * scope size — bounding the read amplification a loop can inflict.
   */
  Searches: 'searches',
} as const;

export type QuotaBucket = (typeof QuotaBucket)[keyof typeof QuotaBucket];

export interface ConsumeQuotaInput {
  /**
   * The PARTITION KEY for anti-ban state: buckets + circuit breaker are shared
   * per Telegram account (sessionRef), because the daemon opens one MTProto
   * connection per sessionRef that several endpoints may ride. Keying per
   * endpoint would grant each a full independent quota with no shared cool-down.
   */
  readonly sessionRef: SessionRefValue;
  /** Human-readable endpoint identity for error/audit messages only (not the key). */
  readonly endpointName: EndpointNameValue;
  readonly bucket: QuotaBucket;
  /** Units to reserve (default 1). */
  readonly units?: number;
}

export interface RateLimiter {
  /**
   * Atomically reserve quota. Ok(void) => proceed; Err(QUOTA_EXCEEDED with
   * retryAfterSeconds) => back off. FAIL-CLOSED on ambiguity.
   */
  tryConsume(input: ConsumeQuotaInput): Promise<Result<void, AppError>>;
}
