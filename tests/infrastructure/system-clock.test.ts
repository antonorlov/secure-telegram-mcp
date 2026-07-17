import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/infrastructure/clock/system-clock.js';

describe('SystemClock', () => {
  it('uses the monotonic process clock for elapsed-time decisions', () => {
    const clock = new SystemClock();
    const before = performance.now();
    const actual = clock.nowMs();
    const after = performance.now();

    expect(actual).toBeGreaterThanOrEqual(before);
    expect(actual).toBeLessThanOrEqual(after);
  });
});
