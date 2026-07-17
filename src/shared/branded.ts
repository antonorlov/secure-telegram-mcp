/**
 * Branded (nominal) types — give structurally-identical primitives distinct
 * identities so e.g. a raw chat id can't be passed where an endpoint name is
 * expected. The brand is a compile-time phantom only; it erases at runtime.
 */

declare const __brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [__brand]: B };

/**
 * Construct a branded value. Unchecked by design — VALIDATION belongs to the
 * owning value object's factory (e.g. `EndpointName.create`). Apply the brand
 * at the bottom of a validated factory, never across call sites.
 */
export const brand = <B extends string, T>(value: T): Brand<T, B> =>
  value as Brand<T, B>;
