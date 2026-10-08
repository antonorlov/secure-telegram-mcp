// The cursor is opaque, minted by the gateway adapter; callers must not parse it — no peer ids
// leak through.
export type Cursor = string;

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: Cursor;
}
