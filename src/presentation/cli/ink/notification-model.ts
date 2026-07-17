/**
 * notification-model — the bounded model for ephemeral status: the single source of truth
 * for "what transient status is currently shown". A fixed-capacity ring: pushing past
 * {@link STATUS_CAP} evicts the oldest item, so the status area self-clears and never grows
 * into a junk pile.
 *
 * Framework-free: no React/Ink import — a pure reducer so the eviction contract is pinned by
 * a unit test, not re-derived in a hook. The Ink component (EphemeralStatus) projects this
 * state; the setup.ts call sites decide what gets pushed.
 *
 * No timers/TTL. The area self-clears on two events — capacity eviction, and a `clear` the
 * app dispatches when the user leaves the screen that produced the status (its context is
 * gone). Clearing tracks navigation, not a clock — it never wipes a line you're still reading
 * nor keeps one past its context.
 */

/**
 * One ephemeral status line. `id` is a monotonic sequence stamped by the controller (a
 * stable React key that survives eviction re-indexing — unlike an array index, which would
 * shift as the oldest item drops off).
 */
export interface StatusItem {
  readonly id: number;
  readonly text: string;
}

/**
 * The ring capacity — reused for both the model cap and the reserved footer row-count, so the
 * status area's height and the eviction threshold can never drift apart.
 */
export const STATUS_CAP = 3;

/**
 * Mutations: `push` appends one item (oldest evicted past capacity); `clear` empties the area
 * (dispatched on a screen-dismiss — see the module header).
 */
export type StatusAction =
  | { readonly type: 'push'; readonly item: StatusItem }
  | { readonly type: 'clear' };

/**
 * Pure reducer. `push`: append then keep the last {@link STATUS_CAP} — immutable (a fresh
 * array, so React re-renders). `clear`: drop everything, but return the same empty reference
 * when already empty so a redundant clear triggers no re-render.
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

// Status tone (pure — EphemeralStatus maps tones to theme tokens)

/** How a transient status line is tinted: failures red, acknowledgments dim. */
export type StatusTone = 'error' | 'muted' | 'default';

const STATUS_ERROR_RE = /^(?:Could not|Cannot|Wrong|Too many)\b|\bfailed\b|\bNOT saved\b/;
const STATUS_MUTED_RE = /\bcancelled\b/i;

/**
 * Conservative prefix/keyword rules over our own copy: unambiguous failures tint as
 * errors, cancellations dim as acknowledgments, and everything else — including
 * successes, whose wordings vary too much for a safe rule — stays at full contrast.
 */
export const classifyStatusTone = (text: string): StatusTone => {
  if (STATUS_ERROR_RE.test(text)) return 'error';
  if (STATUS_MUTED_RE.test(text)) return 'muted';
  return 'default';
};
