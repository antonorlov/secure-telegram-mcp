import { describe, it, expect } from 'vitest';
import { unwrap } from '../../src/shared/result.js';
import {
  Endpoint,
  EndpointName,
  SessionRef,
  Scope,
  PermissionVerb,
} from '../../src/domain/index.js';

const endpoint = (
  verbs: PermissionVerb[],
  confirmWrites = true,
): Endpoint =>
  Endpoint.create({
    name: unwrap(EndpointName.create('e')),
    scope: Scope.create([], []),
    verbs,
    sessionRef: unwrap(SessionRef.create('main')),
    confirmWrites,
    tokenHash: `${'0'.repeat(32)}$${'0'.repeat(64)}`,
  });

describe('Endpoint (aggregate root)', () => {
  it('permits only the verbs it was created with (default-deny, INVARIANT #3)', () => {
    const e = endpoint([PermissionVerb.Read, PermissionVerb.Send]);
    expect(e.permits(PermissionVerb.Read)).toBe(true);
    expect(e.permits(PermissionVerb.Send)).toBe(true);
    expect(e.permits(PermissionVerb.Delete)).toBe(false);
  });

  it('MERGES verbs without shadowing and de-duplicates', () => {
    const e = endpoint([
      PermissionVerb.Read,
      PermissionVerb.Send,
      PermissionVerb.Read,
      PermissionVerb.Draft,
    ]);
    expect(e.permits(PermissionVerb.Read)).toBe(true);
    expect(e.permits(PermissionVerb.Send)).toBe(true);
    expect(e.permits(PermissionVerb.Draft)).toBe(true);
  });

  it('an empty verb set permits nothing', () => {
    const e = endpoint([]);
    for (const verb of Object.values(PermissionVerb)) {
      expect(e.permits(verb)).toBe(false);
    }
  });

  it('requires confirmation for write verbs when confirmWrites is on', () => {
    const e = endpoint([PermissionVerb.Read, PermissionVerb.Send]);
    expect(e.confirmWrites).toBe(true);
    expect(e.requiresConfirmation(PermissionVerb.Send)).toBe(true);
    expect(e.requiresConfirmation(PermissionVerb.Read)).toBe(false);
    // mark_read is a WRITE verb now (it fires read receipts), so HITL gates it too.
    expect(e.requiresConfirmation(PermissionVerb.MarkRead)).toBe(true);
  });

  it('never confirms writes when confirmWrites is explicitly disabled', () => {
    const e = endpoint([PermissionVerb.Send], false);
    expect(e.requiresConfirmation(PermissionVerb.Send)).toBe(false);
  });

  it('is immutable', () => {
    const e = endpoint([PermissionVerb.Read]);
    expect(Object.isFrozen(e)).toBe(true);
  });
});
