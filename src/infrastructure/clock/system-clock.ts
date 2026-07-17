/** SystemClock — monotonic durations plus wall-clock audit timestamps. */
import { performance } from 'node:perf_hooks';

import type { Clock } from '../../application/index.js';

export class SystemClock implements Clock {
  public nowMs(): number {
    return performance.now();
  }

  public nowIso(): string {
    return new Date().toISOString();
  }
}
