import { describe, expect, it } from 'vitest';

import { PolicyContexts } from '../../src/presentation/mcp/policy-contexts.js';

describe('PolicyContexts', () => {
  it('clears synchronously and disposes only the retired bindings', async () => {
    const disposed: string[] = [];
    const contexts = new PolicyContexts<{ readonly id: string }>(
      (context) => {
        disposed.push(context.id);
        return Promise.resolve();
      },
      () => undefined,
    );
    const old = contexts.get('reader', () => Promise.resolve({ id: 'old' }));

    contexts.retire();
    const replacement = contexts.get('reader', () =>
      Promise.resolve({ id: 'new' }),
    );
    expect(replacement).not.toBe(old);
    await contexts.barrier();

    expect(disposed).toEqual(['old']);
    expect((await replacement).id).toBe('new');
  });

  it('retires selected account bindings without evicting unrelated ones', async () => {
    const disposed: string[] = [];
    const contexts = new PolicyContexts<{ readonly id: string }>(
      (context) => {
        disposed.push(context.id);
        return Promise.resolve();
      },
      () => undefined,
    );
    const first = contexts.get('first', () => Promise.resolve({ id: 'first' }));
    const second = contexts.get('second', () => Promise.resolve({ id: 'second' }));

    contexts.retire(new Set(['first']));

    const firstReplacement = contexts.get('first', () =>
      Promise.resolve({ id: 'replacement' }),
    );
    const secondStillCached = contexts.get('second', () =>
      Promise.reject(new Error('unrelated context was evicted')),
    );
    expect(firstReplacement).not.toBe(first);
    expect(secondStillCached).toBe(second);
    await contexts.barrier();
    expect(disposed).toEqual(['first']);
  });

  it('a retired rejection cannot evict its replacement', async () => {
    let rejectOld!: (error: Error) => void;
    const old = new Promise<{ readonly id: string }>((_resolve, reject) => {
      rejectOld = reject;
    });
    const contexts = new PolicyContexts<{ readonly id: string }>(
      () => Promise.resolve(),
      () => undefined,
    );
    void contexts.get('reader', () => old);

    contexts.retire();
    const replacement = contexts.get('reader', () =>
      Promise.resolve({ id: 'new' }),
    );
    rejectOld(new Error('retired build failed late'));
    await contexts.barrier();

    expect(
      contexts.get('reader', () =>
        Promise.reject(new Error('replacement was evicted')),
      ),
    ).toBe(replacement);
  });
});
