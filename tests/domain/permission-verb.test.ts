import { describe, it, expect } from 'vitest';
import {
  PermissionVerb,
  ALL_PERMISSION_VERBS,
  isReadVerb,
  isWriteVerb,
  isPermissionVerb,
} from '../../src/domain/index.js';

describe('PermissionVerb', () => {
  it('enumerates every verb exactly once and is frozen', () => {
    expect(new Set(ALL_PERMISSION_VERBS).size).toBe(ALL_PERMISSION_VERBS.length);
    expect(ALL_PERMISSION_VERBS).toHaveLength(8);
    expect(Object.isFrozen(ALL_PERMISSION_VERBS)).toBe(true);
  });

  it('classifies read verbs (PASSIVE) — read, read_media', () => {
    expect(isReadVerb(PermissionVerb.Read)).toBe(true);
    expect(isReadVerb(PermissionVerb.ReadMedia)).toBe(true);
    expect(isReadVerb(PermissionVerb.Send)).toBe(false);
    // mark_read fires read receipts — an observable effect, so NOT a read verb.
    expect(isReadVerb(PermissionVerb.MarkRead)).toBe(false);
  });

  it('classifies write verbs (observable) — send/draft/delete/mark_read/forward/react', () => {
    for (const verb of [
      PermissionVerb.Send,
      PermissionVerb.Draft,
      PermissionVerb.Delete,
      PermissionVerb.MarkRead,
      PermissionVerb.Forward,
      PermissionVerb.React,
    ]) {
      expect(isWriteVerb(verb)).toBe(true);
      expect(isReadVerb(verb)).toBe(false);
    }
  });

  it('read and write tiers are mutually exclusive and exhaustive', () => {
    for (const verb of ALL_PERMISSION_VERBS) {
      expect(isReadVerb(verb) !== isWriteVerb(verb)).toBe(true);
    }
  });

  it('isPermissionVerb is a fail-closed guard over unknown input', () => {
    expect(isPermissionVerb('read')).toBe(true);
    // The unshipped admin tier is no longer accepted vocabulary — fail closed.
    expect(isPermissionVerb('admin.read')).toBe(false);
    expect(isPermissionVerb('admin')).toBe(false);
    expect(isPermissionVerb('superuser')).toBe(false);
    expect(isPermissionVerb(42)).toBe(false);
    expect(isPermissionVerb(null)).toBe(false);
    expect(isPermissionVerb(undefined)).toBe(false);
  });
});
