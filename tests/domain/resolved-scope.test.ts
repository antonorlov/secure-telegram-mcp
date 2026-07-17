import { describe, it, expect } from 'vitest';
import { isErr, isOk, unwrap } from '../../src/shared/result.js';
import { ChatId, ResolvedScope, DomainErrorCode } from '../../src/domain/index.js';

describe('ResolvedScope', () => {
  it('fails closed on an empty allow-list', () => {
    const result = ResolvedScope.create([]);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe(DomainErrorCode.EmptyScope);
    }
  });

  it('membership is by canonical id', () => {
    const a = unwrap(ChatId.create(-1001234567890n));
    const scope = unwrap(ResolvedScope.create([a]));
    expect(scope.contains(unwrap(ChatId.create(-1001234567890n)))).toBe(true);
    expect(scope.contains(unwrap(ChatId.create(42n)))).toBe(false);
  });

  it('deduplicates peers', () => {
    const a = unwrap(ChatId.create(7n));
    const result = ResolvedScope.create([a, unwrap(ChatId.create(7n))]);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.size).toBe(1);
    }
  });
});
