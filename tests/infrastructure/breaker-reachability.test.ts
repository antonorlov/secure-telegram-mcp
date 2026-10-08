/**
 * The anti-ban circuit breaker against the constants that actually ship. It counts refusals
 * whose back-off reaches `longWaitSeconds`, so a threshold no single request can produce makes
 * the whole breaker dead code — which is exactly what it was until the default dropped from 10s
 * to 3s. Everything here runs on `DEFAULT_QUOTA` and `DEFAULT_CIRCUIT_BREAKER` as exported, never
 * on a tuned copy, so a later change to either side breaks this file rather than the promise.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CIRCUIT_BREAKER,
  TokenBucketRateLimiter,
} from '../../src/infrastructure/rate-limit/token-bucket-rate-limiter.js';
import { DEFAULT_QUOTA } from '../../src/presentation/mcp/daemon.js';
import { MAX_SEARCH_FANOUT_CALLS, QuotaBucket } from '../../src/application/index.js';
import type { Clock, QuotaBucket as QuotaBucketType } from '../../src/application/index.js';
import { EndpointName, SessionRef } from '../../src/domain/index.js';
import type { EndpointNameValue, SessionRefValue } from '../../src/domain/index.js';

// Frozen, so nothing refills: every refusal sees an empty bucket and the worst back-off.
class FrozenClock implements Clock {
  public nowMs(): number {
    return 1_700_000_000_000;
  }
  public nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }
}

const unwrap = <T>(r: { ok: boolean; value?: T }): T => {
  if (!r.ok || r.value === undefined) throw new Error('expected Ok');
  return r.value;
};

const ACCOUNT: SessionRefValue = unwrap(SessionRef.create('busy-account'));
const NEIGHBOUR: SessionRefValue = unwrap(SessionRef.create('calm-account'));
const ENDPOINT: EndpointNameValue = unwrap(EndpointName.create('worker'));

// The largest single reservation each bucket can be asked for in one call.
const MAX_UNITS: Readonly<Record<QuotaBucketType, number>> = {
  [QuotaBucket.Messages]: 1,
  [QuotaBucket.Forwards]: 1,
  [QuotaBucket.Searches]: MAX_SEARCH_FANOUT_CALLS,
};

const CAPACITY: Readonly<Record<QuotaBucketType, number>> = {
  [QuotaBucket.Messages]: DEFAULT_QUOTA.messagesPerMin,
  [QuotaBucket.Forwards]: DEFAULT_QUOTA.forwardsPerMin,
  [QuotaBucket.Searches]: DEFAULT_QUOTA.searchesPerMin,
};

// The longest back-off one request can be told to wait: its whole size against an empty bucket.
const worstBackoffSeconds = (bucket: QuotaBucketType): number =>
  Math.ceil((MAX_UNITS[bucket] * 60) / CAPACITY[bucket]);

describe('the anti-ban breaker is reachable with the shipped constants', () => {
  it('at least one bucket can produce a back-off long enough to count as a strike', () => {
    const worst = Object.values(QuotaBucket).map((bucket) => ({
      bucket,
      seconds: worstBackoffSeconds(bucket),
    }));

    expect(
      worst.some(({ seconds }) => seconds >= DEFAULT_CIRCUIT_BREAKER.longWaitSeconds),
      `no bucket can reach ${String(DEFAULT_CIRCUIT_BREAKER.longWaitSeconds)}s: ${JSON.stringify(worst)}`,
    ).toBe(true);
  });

  it('opens after the threshold of strikes and then refuses every bucket of that account', async () => {
    const limiter = new TokenBucketRateLimiter(new FrozenClock(), DEFAULT_QUOTA);
    const consume = (
      sessionRef: SessionRefValue,
      bucket: QuotaBucketType,
    ): ReturnType<TokenBucketRateLimiter['tryConsume']> =>
      limiter.tryConsume({ sessionRef, endpointName: ENDPOINT, bucket });

    // Spend the whole per-minute message budget.
    for (let i = 0; i < DEFAULT_QUOTA.messagesPerMin; i += 1) {
      expect((await consume(ACCOUNT, QuotaBucket.Messages)).ok, `message ${String(i)}`).toBe(
        true,
      );
    }
    // Each further refusal is a long back-off; the threshold of them trips the breaker.
    for (let i = 0; i < DEFAULT_CIRCUIT_BREAKER.threshold; i += 1) {
      expect((await consume(ACCOUNT, QuotaBucket.Messages)).ok).toBe(false);
    }

    // A bucket this account has not touched is now refused too — by the breaker, not the bucket.
    const frozen = await consume(ACCOUNT, QuotaBucket.Searches);
    expect(frozen.ok).toBe(false);
    expect(JSON.stringify(frozen)).toContain('circuit breaker');

    // And the account next door never paid for it.
    expect((await consume(NEIGHBOUR, QuotaBucket.Messages)).ok).toBe(true);
  });
});
