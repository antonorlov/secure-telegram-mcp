/**
 * notification-model tests — the bounded ephemeral-status ring (lane 2), pinned as
 * a PURE reducer (zero Ink, like `moveMenuIndex`). The load-bearing contract: past
 * STATUS_CAP the OLDEST item is evicted, the model never grows, and the reduce is
 * immutable (a fresh array, input untouched) so React re-renders.
 */
import { describe, it, expect } from 'vitest';

import {
  classifyStatusTone,
  reduceStatus,
  STATUS_CAP,
  type StatusItem,
} from '../../../src/presentation/cli/ink/notification-model.js';

const push = (
  state: readonly StatusItem[],
  item: StatusItem,
): readonly StatusItem[] => reduceStatus(state, { type: 'push', item });

describe('reduceStatus — bounded ring with oldest-eviction', () => {
  it('caps at STATUS_CAP, evicting the oldest, preserving monotonic ids', () => {
    // Push CAP+2 items id:1..CAP+2 through the reducer, one at a time.
    let state: readonly StatusItem[] = [];
    const total = STATUS_CAP + 2;
    for (let id = 1; id <= total; id += 1) {
      state = push(state, { id, text: `N${String(id)}` });
    }
    // Only the last CAP survive; the two oldest (id 1,2) are evicted.
    expect(state).toHaveLength(STATUS_CAP);
    expect(state.map((s) => s.id)).toEqual([
      total - 2,
      total - 1,
      total,
    ]);
    // ids are strictly increasing (order preserved, no shuffle).
    expect(state.map((s) => s.id)).toEqual(
      [...state].map((s) => s.id).sort((a, b) => a - b),
    );
  });

  it('is immutable — the input array is never mutated', () => {
    const base: readonly StatusItem[] = [{ id: 1, text: 'N1' }];
    const next = push(base, { id: 2, text: 'N2' });
    expect(base).toEqual([{ id: 1, text: 'N1' }]); // unchanged
    expect(next).not.toBe(base); // fresh reference => React re-renders
    expect(next).toEqual([
      { id: 1, text: 'N1' },
      { id: 2, text: 'N2' },
    ]);
  });

  it('keeps every item while under capacity', () => {
    let state: readonly StatusItem[] = [];
    state = push(state, { id: 1, text: 'N1' });
    state = push(state, { id: 2, text: 'N2' });
    expect(state).toHaveLength(2);
    expect(state.map((s) => s.text)).toEqual(['N1', 'N2']);
  });
});

describe('reduceStatus — clear on context change (screen dismiss)', () => {
  it('empties the area — a stale line does not linger past its screen', () => {
    const state: readonly StatusItem[] = [
      { id: 1, text: 'Wrong PIN.' },
      { id: 2, text: 'Unlocked.' },
    ];
    const cleared = reduceStatus(state, { type: 'clear' });
    expect(cleared).toEqual([]);
    expect(state).toHaveLength(2); // immutable: input untouched
  });

  it('is a no-op reference when already empty (no needless re-render)', () => {
    const empty: readonly StatusItem[] = [];
    // The common case: dismissing a screen that showed no status.
    expect(reduceStatus(empty, { type: 'clear' })).toBe(empty);
  });
});

describe('classifyStatusTone — failures red, cancellations dim, rest default', () => {
  it('tints unambiguous failures as errors', () => {
    expect(classifyStatusTone('Could not export recovery keyfile: denied')).toBe('error');
    expect(classifyStatusTone('Cannot reach Telegram MCP: refused.')).toBe('error');
    expect(classifyStatusTone('Wrong PIN.')).toBe('error');
    expect(classifyStatusTone('Too many attempts; aborting PIN entry.')).toBe('error');
    expect(classifyStatusTone('Login failed: timeout')).toBe('error');
    expect(classifyStatusTone('Change NOT saved: invalid draft')).toBe('error');
  });

  it('dims cancellations', () => {
    expect(classifyStatusTone('PIN entry cancelled.')).toBe('muted');
    expect(classifyStatusTone('Export cancelled (no path given).')).toBe('muted');
  });

  it('leaves successes and neutral guidance at full contrast', () => {
    expect(classifyStatusTone('PIN changed.')).toBe('default');
    expect(classifyStatusTone('Logged in as Test User.')).toBe('default');
    expect(classifyStatusTone('Config applied live (abc123).')).toBe('default');
  });
});
