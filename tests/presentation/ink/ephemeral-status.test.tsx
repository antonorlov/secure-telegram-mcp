/**
 * EphemeralStatus tests (lane 2, the COMPONENT) — the SMALL, FIXED, self-clearing
 * status area that replaced the 12-line rolling transcript pile.
 *
 * Two load-bearing properties:
 *   1. EVICTION is visible on the CURRENT frame: after pushing past STATUS_CAP, the
 *      oldest line is GONE from `lastFrame()`. (Asserted on lastFrame, NOT on the
 *      frames history, which retains evicted content by design.)
 *   2. The reserved height is STABLE: the frame is the same number of rows with 0
 *      items and with STATUS_CAP items, so the active screen below never shifts.
 */
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';

import {
  EphemeralStatus,
} from '../../../src/presentation/cli/ink/run-setup-app.js';
import {
  STATUS_CAP,
  reduceStatus,
  type StatusItem,
} from '../../../src/presentation/cli/ink/notification-model.js';

const rows = (frame: string | undefined): number =>
  (frame ?? '').split('\n').length;

describe('EphemeralStatus — bounded, self-evicting area', () => {
  it('drops the OLDEST line from the current frame once past STATUS_CAP', () => {
    // Drive the ring through the SAME reducer the app uses, projecting each step.
    let ring: readonly StatusItem[] = [];
    const feed = (id: number): void => {
      ring = reduceStatus(ring, { type: 'push', item: { id, text: `N${String(id)}` } });
    };

    const { lastFrame, rerender } = render(<EphemeralStatus items={ring} />);
    // Push N1..N4 with CAP=3 → N1 must be evicted.
    for (let id = 1; id <= STATUS_CAP + 1; id += 1) {
      feed(id);
      rerender(<EphemeralStatus items={ring} />);
    }
    const frame = lastFrame() ?? '';
    expect(frame).toContain('N2');
    expect(frame).toContain('N3');
    expect(frame).toContain('N4');
    // The promised behaviour: the oldest line is gone from what is on screen NOW.
    expect(frame).not.toContain('N1');
  });

  it('reserves a CONSTANT height so the screen below never shifts', () => {
    const empty = render(<EphemeralStatus items={[]} />);
    const emptyRows = rows(empty.lastFrame());

    const full: readonly StatusItem[] = Array.from(
      { length: STATUS_CAP },
      (_, i) => ({ id: i, text: `N${String(i)}` }),
    );
    const filled = render(<EphemeralStatus items={full} />);
    const filledRows = rows(filled.lastFrame());

    // Same row-count with 0 and CAP items — the reserved box is fixed height.
    expect(filledRows).toBe(emptyRows);
  });
});
