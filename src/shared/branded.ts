// Compile-time phantom brand; it erases at runtime.

declare const __brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [__brand]: B };

// Unchecked by design — validation belongs to the owning value object's factory. Apply the
// brand at the bottom of a validated factory, never across call sites.
export const brand = <B extends string, T>(value: T): Brand<T, B> =>
  value as Brand<T, B>;
