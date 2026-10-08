
// Fails closed at compile time and at runtime.
export const assertNever = (value: never, context?: string): never => {
  throw new Error(
    `Unreachable case reached${context ? ` in ${context}` : ''}: ${JSON.stringify(value)}`,
  );
};

export const uniqueFrozen = <T>(items: readonly T[]): readonly T[] =>
  Object.freeze([...new Set(items)]);
