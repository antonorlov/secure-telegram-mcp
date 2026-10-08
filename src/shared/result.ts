// Expected outcomes (an ACL denial) travel as `Result`; throwing is reserved for programmer
// errors.

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;

export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

// ONLY for call sites that have already proven success.
export const unwrap = <T, E>(r: Result<T, E>): T => {
  if (r.ok) {
    return r.value;
  }
  throw new Error(`Result.unwrap on Err: ${String(r.error)}`);
};
