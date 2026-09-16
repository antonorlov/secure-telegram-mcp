// The bounded model for ephemeral status: a fixed-capacity ring where pushing past `STATUS_CAP`
// evicts the oldest item, so the status area self-clears and never grows.

// `id` is a monotonic sequence stamped by the controller — a stable React key that survives
// eviction re-indexing, unlike an array index, which would shift as the oldest item drops off.
export interface StatusItem {
  readonly id: number;
  readonly text: string;
}

// Reused for both the model cap and the reserved footer row-count, so the status area's height
// and the eviction threshold can never drift apart.
export const STATUS_CAP = 3;

// `push` appends one item, evicting the oldest past capacity; `clear` empties the area on a
// screen dismiss.
export type StatusAction =
  | { readonly type: 'push'; readonly item: StatusItem }
  | { readonly type: 'clear' };

/**
 * `push` appends then keeps the last `STATUS_CAP` in a fresh array, so React re-renders.
 * `clear` returns the same empty reference when already empty, so a redundant clear triggers no
 * re-render.
 */
export const reduceStatus = (
  state: readonly StatusItem[],
  action: StatusAction,
): readonly StatusItem[] => {
  switch (action.type) {
    case 'push':
      return [...state, action.item].slice(-STATUS_CAP);
    case 'clear':
      return state.length === 0 ? state : [];
  }
};

// How a transient status line is tinted: failures red, acknowledgments dim.
export type StatusTone = 'error' | 'muted' | 'default';

const STATUS_ERROR_RE = /^(?:Could not|Cannot|Wrong|Too many)\b|\bfailed\b|\bNOT saved\b/;
const STATUS_MUTED_RE = /\bcancelled\b/i;

/**
 * Conservative prefix and keyword rules over our own copy: unambiguous failures tint as errors,
 * cancellations dim as acknowledgments, and everything else — including successes, whose
 * wordings vary too much for a safe rule — stays at full contrast.
 */
export const classifyStatusTone = (text: string): StatusTone => {
  if (STATUS_ERROR_RE.test(text)) return 'error';
  if (STATUS_MUTED_RE.test(text)) return 'muted';
  return 'default';
};
