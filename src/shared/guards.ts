/**
 * Small, dependency-free type guards & immutable helpers shared across layers.
 * Pure functions only — no I/O, no mutation of inputs.
 */

/** Exhaustiveness helper for discriminated unions — fails closed at compile + runtime. */
export const assertNever = (value: never, context?: string): never => {
  throw new Error(
    `Unreachable case reached${context ? ` in ${context}` : ''}: ${JSON.stringify(value)}`,
  );
};

/** Build an immutable, de-duplicated readonly array preserving first-seen order. */
export const uniqueFrozen = <T>(items: readonly T[]): readonly T[] =>
  Object.freeze([...new Set(items)]);
