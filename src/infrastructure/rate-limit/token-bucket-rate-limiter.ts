/**
 * Paces writes proactively so an endpoint never trips Telegram's anti-spam heuristics in the
 * first place, independent of the reactive FLOOD_WAIT the gateway maps.
 * Three mechanisms, all keyed per session: a refilling token bucket per anti-ban bucket
 * (messages, forwards, searches) that hands out time-spaced slots; a per-minute capacity that
 * IS the quota; and a circuit breaker that opens after repeated long back-offs and then refuses
 * everything for a cooldown.
 */
import {
  QuotaBucket,
  AppErrorCode,
  appError,
} from '../../application/index.js';
import type {
  RateLimiter,
  ConsumeQuotaInput,
  AppError,
  Clock,
} from '../../application/index.js';
import { ok, err } from '../../shared/index.js';
import type { Result } from '../../shared/index.js';

const MINUTE_MS = 60_000;

// Capacity per minute is both the quota and the maximum burst; divided across the minute it is
// the steady refill rate.
export interface BucketLimits {
  readonly messagesPerMin: number;
  readonly forwardsPerMin: number;
  // An un-peered whole-scope search reserves one unit per in-scope chat, so this also bounds
  // fan-out amplification per minute.
  readonly searchesPerMin: number;
}

/**
 * A refusal whose back-off is at least `longWaitSeconds` counts as a strike; `threshold`
 * strikes inside `windowMs` trip the breaker, which then refuses all consumption for
 * `cooldownMs`.
 */
export interface CircuitBreakerOptions {
  readonly longWaitSeconds: number;
  readonly threshold: number;
  readonly windowMs: number;
  readonly cooldownMs: number;
}

// Conservative defaults — sustained saturation, not a single hiccup, trips it.
export const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerOptions = Object.freeze({
  longWaitSeconds: 10,
  threshold: 3,
  windowMs: MINUTE_MS,
  cooldownMs: MINUTE_MS,
});

interface BucketState {
  // Fractional — refills continuously.
  tokens: number;
  readonly capacity: number;
  readonly refillPerMs: number;
  lastRefillMs: number;
}

interface EndpointState {
  readonly buckets: ReadonlyMap<QuotaBucket, BucketState>;
  strikes: number[];
  // Monotonic timestamp until which the breaker is open; 0 when closed.
  breakerOpenUntilMs: number;
}

export class TokenBucketRateLimiter implements RateLimiter {
  // Per-ACCOUNT state keyed by sessionRef, shared by all its endpoints.
  private readonly sessions = new Map<string, EndpointState>();

  public constructor(
    private readonly clock: Clock,
    private readonly limits: BucketLimits,
    private readonly breaker: CircuitBreakerOptions = DEFAULT_CIRCUIT_BREAKER,
  ) {}

  // Runs synchronously, so the reservation is atomic within the event-loop turn.
  public tryConsume(
    input: ConsumeQuotaInput,
  ): Promise<Result<void, AppError>> {
    return Promise.resolve(this.reserve(input));
  }

  public forgetSession(sessionRef: string): void {
    this.sessions.delete(sessionRef);
  }

  private reserve(input: ConsumeQuotaInput): Result<void, AppError> {
    const units = input.units ?? 1;
    if (!Number.isInteger(units) || units < 1) {
      return err(
        appError(
          AppErrorCode.Validation,
          `Quota units must be a positive integer (got ${String(units)}).`,
        ),
      );
    }

    const nowMs = this.clock.nowMs();
    const state = this.sessionStateFor(String(input.sessionRef), nowMs);

    // 1. Circuit breaker takes precedence: while open, the whole endpoint is
    //    frozen (fail-closed) so the account can cool down.
    if (state.breakerOpenUntilMs > 0) {
      if (nowMs < state.breakerOpenUntilMs) {
        return err(
          appError(
            AppErrorCode.QuotaExceeded,
            `Anti-ban circuit breaker open for endpoint "${input.endpointName}".`,
            { retryAfterSeconds: secondsBetween(nowMs, state.breakerOpenUntilMs) },
          ),
        );
      }
      // Cooldown elapsed -> half-open: clear memory and allow this attempt.
      state.breakerOpenUntilMs = 0;
      state.strikes = [];
    }

    // 2. Resolve the requested bucket. Unknown bucket => fail-closed.
    const bucket = state.buckets.get(input.bucket);
    if (bucket === undefined) {
      return err(
        appError(
          AppErrorCode.Validation,
          `Unknown quota bucket: "${input.bucket}".`,
        ),
      );
    }

    // A request larger than a full bucket can never be satisfied — refuse
    // deterministically rather than reporting an unbounded back-off.
    if (units > bucket.capacity) {
      return err(
        appError(
          AppErrorCode.Validation,
          `Requested ${String(units)} units exceed the ${input.bucket} capacity of ${String(bucket.capacity)}.`,
        ),
      );
    }

    // 3. Refill, then attempt the reservation.
    refill(bucket, nowMs);
    if (bucket.tokens >= units) {
      bucket.tokens -= units;
      return ok(undefined);
    }

    // 4. Not enough slots: compute exact back-off and register a strike if the
    //    wait is "long" enough to matter to the breaker.
    const deficit = units - bucket.tokens;
    const bucketRetrySeconds = Math.max(
      1,
      Math.ceil(deficit / bucket.refillPerMs / 1000),
    );
    if (bucketRetrySeconds >= this.breaker.longWaitSeconds) {
      this.addStrike(state, nowMs);
    }
    /**
     * If that strike TRIPPED the breaker, the bucket's refill estimate is a lie — the whole
     * session is frozen for the cooldown. Report the LATER of the two, so the caller's next
     * retry cannot land inside the open breaker and be wasted.
     */
    const retryAfterSeconds =
      state.breakerOpenUntilMs > nowMs
        ? Math.max(
            bucketRetrySeconds,
            secondsBetween(nowMs, state.breakerOpenUntilMs),
          )
        : bucketRetrySeconds;
    return err(
      appError(
        AppErrorCode.QuotaExceeded,
        `Anti-ban quota exhausted for bucket "${input.bucket}" on endpoint "${input.endpointName}".`,
        { retryAfterSeconds },
      ),
    );
  }

  // Get-or-create the per-session state, lazily seeding fresh buckets.
  private sessionStateFor(sessionKey: string, nowMs: number): EndpointState {
    const existing = this.sessions.get(sessionKey);
    if (existing !== undefined) {
      return existing;
    }
    const buckets = new Map<QuotaBucket, BucketState>([
      [QuotaBucket.Messages, newBucket(this.limits.messagesPerMin, nowMs)],
      [QuotaBucket.Forwards, newBucket(this.limits.forwardsPerMin, nowMs)],
      [QuotaBucket.Searches, newBucket(this.limits.searchesPerMin, nowMs)],
    ]);
    const created: EndpointState = {
      buckets,
      strikes: [],
      breakerOpenUntilMs: 0,
    };
    this.sessions.set(sessionKey, created);
    return created;
  }

  // Record a long-wait strike; trip the breaker once the window is saturated.
  private addStrike(state: EndpointState, nowMs: number): void {
    const windowStart = nowMs - this.breaker.windowMs;
    const recent = state.strikes.filter((t) => t > windowStart);
    recent.push(nowMs);
    if (recent.length >= this.breaker.threshold) {
      state.breakerOpenUntilMs = nowMs + this.breaker.cooldownMs;
      state.strikes = [];
      return;
    }
    state.strikes = recent;
  }
}

// Build a full bucket (start at capacity so the first burst is allowed).
const newBucket = (capacity: number, nowMs: number): BucketState => ({
  tokens: capacity,
  capacity,
  refillPerMs: capacity / MINUTE_MS,
  lastRefillMs: nowMs,
});

// Continuously refill a bucket up to capacity for elapsed monotonic time.
const refill = (bucket: BucketState, nowMs: number): void => {
  if (nowMs <= bucket.lastRefillMs) {
    return;
  }
  const elapsedMs = nowMs - bucket.lastRefillMs;
  bucket.tokens = Math.min(
    bucket.capacity,
    bucket.tokens + elapsedMs * bucket.refillPerMs,
  );
  bucket.lastRefillMs = nowMs;
};

// Whole seconds from `nowMs` until `untilMs`, at least 1.
const secondsBetween = (nowMs: number, untilMs: number): number =>
  Math.max(1, Math.ceil((untilMs - nowMs) / 1000));
