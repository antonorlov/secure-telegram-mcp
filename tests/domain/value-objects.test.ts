import { describe, it, expect } from 'vitest';
import { isErr, isOk, unwrap } from '../../src/shared/result.js';
import {
  ChatId,
  PeerRefFactory,
  FolderRefFactory,
  EndpointName,
  SessionRef,
  DomainErrorCode,
} from '../../src/domain/index.js';

describe('ChatId', () => {
  it('rejects zero (never a valid peer)', () => {
    const r = ChatId.create(0n);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.code).toBe(DomainErrorCode.InvalidValue);
    }
  });

  it('accepts large negative channel ids beyond Number.MAX_SAFE_INTEGER', () => {
    const r = ChatId.create(-1001234567890n);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.value).toBe(-1001234567890n);
    }
  });

  it('parses decimal strings and rejects non-numeric input', () => {
    expect(isOk(ChatId.fromString('-1001234567890'))).toBe(true);
    expect(isErr(ChatId.fromString('12.5'))).toBe(true);
    expect(isErr(ChatId.fromString('abc'))).toBe(true);
    expect(isErr(ChatId.fromString(''))).toBe(true);
  });

  it('rejects an over-long id string BEFORE parsing (bounded superlinear work)', () => {
    // A 5000-digit payload must be refused by the length guard, never handed to
    // BigInt(); a normal channel id (well under 32 chars) still parses.
    expect(isErr(ChatId.fromString('9'.repeat(5000)))).toBe(true);
    expect(isOk(ChatId.fromString('-1001234567890'))).toBe(true);
  });

  it('toKey is a stable canonical string used for allow-list membership', () => {
    expect(unwrap(ChatId.create(-100n)).toKey()).toBe('-100');
  });

  it('is immutable (frozen)', () => {
    const a = unwrap(ChatId.create(5n));
    expect(Object.isFrozen(a)).toBe(true);
  });
});

describe('PeerRef', () => {
  it('id variant carries a resolved ChatId', () => {
    const ref = PeerRefFactory.fromId(unwrap(ChatId.create(7n)));
    expect(ref.kind).toBe('id');
  });

  it('username variant strips a leading @ and validates the slug', () => {
    const ref = PeerRefFactory.fromUsername('@durov');
    expect(isOk(ref)).toBe(true);
    if (isOk(ref) && ref.value.kind === 'username') {
      expect(ref.value.username).toBe('durov');
    }
  });

  it('rejects malformed usernames (too short / illegal chars / leading digit)', () => {
    expect(isErr(PeerRefFactory.fromUsername('ab'))).toBe(true);
    expect(isErr(PeerRefFactory.fromUsername('has space'))).toBe(true);
    expect(isErr(PeerRefFactory.fromUsername('1leading'))).toBe(true);
  });

  it('me variant is a singleton-shaped discriminant', () => {
    expect(PeerRefFactory.me().kind).toBe('me');
  });

  it('is immutable (frozen)', () => {
    expect(Object.isFrozen(PeerRefFactory.me())).toBe(true);
    expect(Object.isFrozen(PeerRefFactory.fromId(unwrap(ChatId.create(1n))))).toBe(true);
  });
});

describe('FolderRef', () => {
  it('accepts a non-negative numeric id; rejects negatives and non-integers', () => {
    expect(isOk(FolderRefFactory.fromId(0))).toBe(true);
    expect(isOk(FolderRefFactory.fromId(3))).toBe(true);
    expect(isErr(FolderRefFactory.fromId(-1))).toBe(true);
    expect(isErr(FolderRefFactory.fromId(1.2))).toBe(true);
  });

  it('trims titles and rejects blank ones', () => {
    const r = FolderRefFactory.fromTitle('  Work  ');
    expect(isOk(r)).toBe(true);
    if (isOk(r) && r.value.kind === 'title') {
      expect(r.value.title).toBe('Work');
    }
    expect(isErr(FolderRefFactory.fromTitle('   '))).toBe(true);
  });
});

describe('EndpointName / SessionRef slugs', () => {
  it('accepts safe slugs', () => {
    expect(isOk(EndpointName.create('reader-1'))).toBe(true);
    expect(isOk(EndpointName.create('team_chats'))).toBe(true);
    expect(isOk(SessionRef.create('main'))).toBe(true);
  });

  it('rejects unsafe / empty / uppercase / leading-symbol slugs', () => {
    expect(isErr(EndpointName.create(''))).toBe(true);
    expect(isErr(EndpointName.create('Reader'))).toBe(true);
    expect(isErr(EndpointName.create('-leading'))).toBe(true);
    expect(isErr(SessionRef.create('has space'))).toBe(true);
    expect(isErr(EndpointName.create('a'.repeat(65)))).toBe(true);
  });
});
