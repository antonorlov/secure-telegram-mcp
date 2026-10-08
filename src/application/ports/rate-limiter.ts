// Proactive anti-ban quota, independent of Telegram's own FLOOD_WAIT.
import type { Result } from '../../shared/index.js';
import type { EndpointNameValue, SessionRefValue } from '../../domain/index.js';
import type { AppError } from '../errors.js';

export const QuotaBucket = {
  Messages: 'messages',
  Forwards: 'forwards',
  // An un-peered `search_messages` fans out into one search per in-scope chat, so it reserves
  // `units` equal to the scope size.
  Searches: 'searches',
} as const;

export type QuotaBucket = (typeof QuotaBucket)[keyof typeof QuotaBucket];

export interface ConsumeQuotaInput {
  // Partition key for anti-ban state: buckets and breaker are shared per Telegram account,
  // because one MTProto connection per sessionRef may carry several endpoints.
  readonly sessionRef: SessionRefValue;
  readonly endpointName: EndpointNameValue;
  readonly bucket: QuotaBucket;
  // Units to reserve (default 1).
  readonly units?: number;
}

export interface RateLimiter {
  // Atomically reserves. Err(QUOTA_EXCEEDED) means back off; fail-closed on ambiguity.
  tryConsume(input: ConsumeQuotaInput): Promise<Result<void, AppError>>;
}
