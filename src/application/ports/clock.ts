export interface Clock {
  // Monotonic milliseconds; the origin is unspecified.
  nowMs(): number;
  nowIso(): string;
}
