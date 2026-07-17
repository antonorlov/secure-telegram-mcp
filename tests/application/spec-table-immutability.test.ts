/**
 * The spec tables ARE authorization metadata: the engines read verb / bucket /
 * gate hooks from the spec reference at execute time, so both tables and every
 * entry must be frozen — a runtime mutation must throw, never silently desync
 * the engine's ACL verb from the verb the registry snapshot exposes.
 */
import { describe, it, expect } from 'vitest';
import { READ_SPECS } from '../../src/application/use-cases/read-use-case-impls.js';
import { WRITE_SPECS } from '../../src/application/use-cases/write-use-case-impls.js';

describe('spec tables are frozen authorization metadata', () => {
  it('freezes both tables and every entry', () => {
    expect(Object.isFrozen(READ_SPECS)).toBe(true);
    expect(Object.isFrozen(WRITE_SPECS)).toBe(true);
    for (const [name, spec] of [
      ...Object.entries(READ_SPECS),
      ...Object.entries(WRITE_SPECS),
    ]) {
      expect(Object.isFrozen(spec), `spec ${name} must be frozen`).toBe(true);
    }
  });

  it('mutating an entry verb throws instead of drifting the ACL', () => {
    expect(() => {
      (WRITE_SPECS.sendMessage as { verb: unknown }).verb = 'read';
    }).toThrow(TypeError);
  });
});
