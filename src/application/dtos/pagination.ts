/**
 * Pagination DTOs — opaque-cursor paging for in-scope history reads. The
 * cursor is an OPAQUE string minted by the gateway adapter; callers must treat
 * it as a black box (no peer ids leaked through it).
 */
export type Cursor = string;

export interface Page<T> {
  readonly items: readonly T[];
  /** Present when more results exist; pass back verbatim to continue. */
  readonly nextCursor?: Cursor;
}
