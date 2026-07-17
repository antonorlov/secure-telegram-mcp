/**
 * TokenBucketRateLimiter — anti-ban quota is partitioned per SESSION (sessionRef),
 * NOT per endpoint name (M4 regression). The daemon opens ONE MTProto connection
 * per sessionRef and several endpoints may ride it, so all of an account's
 * endpoints must draw down and share ONE bucket set (and ONE circuit breaker) —
 * otherwise each endpoint gets a full independent quota (N× the real send rate).
 */
import { describe, it, expect } from 'vitest';
import { TokenBucketRateLimiter } from '../../src/infrastructure/rate-limit/token-bucket-rate-limiter.js';
import { QuotaBucket } from '../../src/application/index.js';
import type { Clock } from '../../src/application/index.js';
import { SessionRef, EndpointName } from '../../src/domain/index.js';
import type { SessionRefValue, EndpointNameValue } from '../../src/domain/index.js';

const FIXED_MS = 1_700_000_000_000;
class FrozenClock implements Clock {
  public nowMs(): number {
    return FIXED_MS;
  }
  public nowIso(): string {
    return new Date(FIXED_MS).toISOString();
  }
}

/** A manually-advanced clock for the time-dependent breaker/window tests. */
class SteppingClock implements Clock {
  private t = FIXED_MS;
  public nowMs(): number {
    return this.t;
  }
  public nowIso(): string {
    return new Date(this.t).toISOString();
  }
  public advance(ms: number): void {
    this.t += ms;
  }
}

const unwrap = <T>(r: { ok: boolean; value?: T }): T => {
  if (!r.ok || r.value === undefined) {
    throw new Error('expected Ok');
  }
  return r.value;
};

const SESSION: SessionRefValue = unwrap(SessionRef.create('shared-account'));
const EP_A: EndpointNameValue = unwrap(EndpointName.create('work-read'));
const EP_B: EndpointNameValue = unwrap(EndpointName.create('work-write'));

describe('TokenBucketRateLimiter per-session partitioning', () => {
  it('two endpoints on ONE sessionRef share a single messages bucket', async () => {
    // Capacity of 2 messages/min for the whole account.
    const limiter = new TokenBucketRateLimiter(new FrozenClock(), {
      messagesPerMin: 2,
      forwardsPerMin: 10,
      searchesPerMin: 10,
    });

    // First endpoint spends one token...
    const a1 = await limiter.tryConsume({
      sessionRef: SESSION,
      endpointName: EP_A,
      bucket: QuotaBucket.Messages,
    });
    // ...the second endpoint (same account) spends the second...
    const b1 = await limiter.tryConsume({
      sessionRef: SESSION,
      endpointName: EP_B,
      bucket: QuotaBucket.Messages,
    });
    // ...and now the shared bucket is empty: a third send is refused regardless
    // of which endpoint asks (they are NOT two independent quotas).
    const a2 = await limiter.tryConsume({
      sessionRef: SESSION,
      endpointName: EP_A,
      bucket: QuotaBucket.Messages,
    });

    expect(a1.ok).toBe(true);
    expect(b1.ok).toBe(true);
    expect(a2.ok).toBe(false);
    if (!a2.ok) {
      expect(a2.error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });

  it('endpoints on DIFFERENT sessionRefs keep independent quotas', async () => {
    const limiter = new TokenBucketRateLimiter(new FrozenClock(), {
      messagesPerMin: 1,
      forwardsPerMin: 10,
      searchesPerMin: 10,
    });
    const other: SessionRefValue = unwrap(SessionRef.create('other-account'));

    const a = await limiter.tryConsume({
      sessionRef: SESSION,
      endpointName: EP_A,
      bucket: QuotaBucket.Messages,
    });
    // A different account is unaffected by the first account exhausting its bucket.
    const b = await limiter.tryConsume({
      sessionRef: other,
      endpointName: EP_B,
      bucket: QuotaBucket.Messages,
    });
    // The first account is now out.
    const aAgain = await limiter.tryConsume({
      sessionRef: SESSION,
      endpointName: EP_A,
      bucket: QuotaBucket.Messages,
    });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(aAgain.ok).toBe(false);
  });

  it('forgets quota and breaker memory when an account is removed', async () => {
    const limiter = new TokenBucketRateLimiter(new FrozenClock(), {
      messagesPerMin: 1,
      forwardsPerMin: 1,
      searchesPerMin: 1,
    });
    const take = (): ReturnType<TokenBucketRateLimiter['tryConsume']> =>
      limiter.tryConsume({
        sessionRef: SESSION,
        endpointName: EP_A,
        bucket: QuotaBucket.Messages,
      });
    expect((await take()).ok).toBe(true);
    expect((await take()).ok).toBe(false);

    limiter.forgetSession(String(SESSION));

    expect((await take()).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker — the fail-closed cooldown behind sustained saturation
// ---------------------------------------------------------------------------

// Deterministic tuning: a refusal whose back-off is >= 10s is a strike; 3 strikes
// inside 60s trip the breaker. The cooldown (120s) is deliberately DIFFERENT from
// the strike limiter's empty-bucket delay (60s at 1 msg/min) so assertions can
// tell a bucket refusal (60) from a breaker-governed one (120) — with equal
// values the trip-moment response would be untestable.
const BREAKER = {
  longWaitSeconds: 10,
  threshold: 3,
  windowMs: 60_000,
  cooldownMs: 120_000,
};

/** messagesPerMin: 1 -> an empty bucket's back-off is ~60s, always a strike. */
const strikeLimiter = (
  clock: Clock,
): TokenBucketRateLimiter =>
  new TokenBucketRateLimiter(
    clock,
    { messagesPerMin: 1, forwardsPerMin: 10, searchesPerMin: 10 },
    BREAKER,
  );

const consume = (
  limiter: TokenBucketRateLimiter,
  bucket: QuotaBucket = QuotaBucket.Messages,
): ReturnType<TokenBucketRateLimiter['tryConsume']> =>
  limiter.tryConsume({ sessionRef: SESSION, endpointName: EP_A, bucket });

describe('TokenBucketRateLimiter circuit breaker', () => {
  it('the refusal that TRIPS the breaker reports the COOLDOWN, not the shorter bucket delay', async () => {
    const clock = new SteppingClock();
    const limiter = strikeLimiter(clock);

    expect((await consume(limiter)).ok).toBe(true); // bucket now empty
    // Two pre-trip refusals report the honest 60s bucket back-off…
    for (let i = 0; i < 2; i += 1) {
      const r = await consume(limiter);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.retryAfterSeconds).toBe(60);
    }
    // …but the THIRD strike trips the breaker, and telling the caller "60s"
    // would land its retry inside the open breaker (a wasted call): the trip
    // response must already carry the 120s cooldown.
    const tripping = await consume(limiter);
    expect(tripping.ok).toBe(false);
    if (!tripping.ok) {
      expect(tripping.error.retryAfterSeconds).toBe(120);
    }
  });

  it('trips after `threshold` long-wait refusals and then freezes EVERY bucket of the session', async () => {
    const clock = new SteppingClock();
    const limiter = strikeLimiter(clock);

    expect((await consume(limiter)).ok).toBe(true); // bucket now empty
    // Three ~60s-back-off refusals = three strikes = trip.
    expect((await consume(limiter)).ok).toBe(false);
    expect((await consume(limiter)).ok).toBe(false);
    expect((await consume(limiter)).ok).toBe(false);

    // Open: even a bucket with plenty of capacity (forwards) is refused —
    // fail-closed so the whole account cools down.
    const frozen = await consume(limiter, QuotaBucket.Forwards);
    expect(frozen.ok).toBe(false);
    if (!frozen.ok) {
      expect(frozen.error.message).toContain('circuit breaker open');
      expect(frozen.error.retryAfterSeconds).toBe(120);
    }
  });

  it('while open, retryAfterSeconds reports the REMAINING cooldown', async () => {
    const clock = new SteppingClock();
    const limiter = strikeLimiter(clock);
    await consume(limiter);
    await consume(limiter);
    await consume(limiter);
    await consume(limiter); // tripped at t

    clock.advance(30_000);
    const r = await consume(limiter, QuotaBucket.Forwards);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.retryAfterSeconds).toBe(90);
    }
  });

  it('short-wait refusals NEVER strike — saturating a fast bucket cannot trip the breaker', async () => {
    const clock = new SteppingClock();
    // 30 msgs/min -> an empty bucket's single-unit back-off is ~2s, far below the
    // 10s long-wait threshold.
    const limiter = new TokenBucketRateLimiter(
      clock,
      { messagesPerMin: 30, forwardsPerMin: 10, searchesPerMin: 10 },
      BREAKER,
    );
    for (let i = 0; i < 30; i += 1) {
      expect((await consume(limiter)).ok).toBe(true);
    }
    // Hammer the empty bucket well past the strike threshold.
    for (let i = 0; i < 10; i += 1) {
      const r = await consume(limiter);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.message).toContain('quota exhausted'); // never the breaker
      }
    }
    expect((await consume(limiter, QuotaBucket.Forwards)).ok).toBe(true);
  });

  it('strikes EXPIRE with the sliding window — spaced-out long waits never trip', async () => {
    const clock = new SteppingClock();
    const limiter = strikeLimiter(clock);

    await consume(limiter); // spend
    await consume(limiter); // strike 1
    await consume(limiter); // strike 2

    // Past the window: both strikes age out (and the bucket refills).
    clock.advance(61_000);
    expect((await consume(limiter)).ok).toBe(true); // spend again
    await consume(limiter); // a FRESH strike — count 1, not 3
    const r = await consume(limiter, QuotaBucket.Forwards);
    expect(r.ok).toBe(true); // not open: the old strikes no longer count
  });

  it('after the cooldown the breaker half-opens: allows the attempt and CLEARS strike memory', async () => {
    const clock = new SteppingClock();
    const limiter = strikeLimiter(clock);
    await consume(limiter);
    await consume(limiter);
    await consume(limiter);
    await consume(limiter); // tripped

    clock.advance(121_000); // cooldown elapsed (bucket also refilled to 1)
    expect((await consume(limiter)).ok).toBe(true); // half-open lets it through

    // Memory was cleared on reopen: one fresh long-wait strike is 1/3, so the
    // breaker does NOT immediately re-trip.
    await consume(limiter); // long-wait refusal -> strike 1
    expect((await consume(limiter, QuotaBucket.Forwards)).ok).toBe(true);
  });
});
