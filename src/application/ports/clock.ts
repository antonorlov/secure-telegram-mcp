/**
 * Clock port — abstracts time so use-cases (quotas, TTLs, audit timestamps)
 * stay deterministic and testable. Infrastructure provides a system clock;
 * tests provide a fake.
 */
export interface Clock {
  /** Monotonic milliseconds for elapsed-time decisions; origin is unspecified. */
  nowMs(): number;
  /** Current time as an ISO-8601 string (for audit records). */
  nowIso(): string;
}
