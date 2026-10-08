import { describe, expect, it } from 'vitest';

import { AccountRuntimes } from '../../src/presentation/mcp/account-runtimes.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('AccountRuntimes', () => {
  it('shares one build per session reference', async () => {
    let builds = 0;
    const runtimes = new AccountRuntimes<{ readonly id: number }>(() =>
      Promise.resolve(),
    );
    const build = (): Promise<{ readonly id: number }> => {
      builds += 1;
      return Promise.resolve({ id: builds });
    };

    const [first, second] = await Promise.all([
      runtimes.get('main', build),
      runtimes.get('main', build),
    ]);

    expect(first).toBe(second);
    expect(builds).toBe(1);
  });

  it('does not build a replacement until the old owner is disposed', async () => {
    const disposal = deferred<undefined>();
    const order: string[] = [];
    const runtimes = new AccountRuntimes<{ readonly id: string }>(async (runtime) => {
      order.push(`disposing:${runtime.id}`);
      await disposal.promise;
      order.push(`disposed:${runtime.id}`);
    });
    await runtimes.get('main', () => Promise.resolve({ id: 'old' }));
    const retiring = runtimes.withRetired('main', () => Promise.resolve());
    const replacement = runtimes.get('main', () => {
      order.push('built:new');
      return Promise.resolve({ id: 'new' });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['disposing:old']);

    disposal.resolve(undefined);
    await retiring;
    await replacement;
    expect(order).toEqual(['disposing:old', 'disposed:old', 'built:new']);
  });

  it('holds replacement builds until an account mutation completes', async () => {
    const mutation = deferred<undefined>();
    const order: string[] = [];
    const runtimes = new AccountRuntimes<{ readonly id: string }>(() =>
      Promise.resolve(),
    );
    await runtimes.get('main', () => Promise.resolve({ id: 'old' }));

    const mutating = runtimes.withRetired('main', async () => {
      order.push('mutation');
      await mutation.promise;
      order.push('mutated');
    });
    const replacement = runtimes.get('main', () => {
      order.push('built:new');
      return Promise.resolve({ id: 'new' });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['mutation']);

    mutation.resolve(undefined);
    await mutating;
    await replacement;
    expect(order).toEqual(['mutation', 'mutated', 'built:new']);
  });

  it('never rebuilds after teardown leaves Telegram ownership uncertain', async () => {
    let rebuilt = false;
    const runtimes = new AccountRuntimes<{ readonly id: string }>(() =>
      Promise.reject(new Error('destroy failed')),
    );
    await runtimes.get('main', () => Promise.resolve({ id: 'old' }));

    await expect(
      runtimes.withRetired('main', () => Promise.resolve()),
    ).rejects.toThrow('destroy failed');
    await expect(
      runtimes.get('main', () => {
        rebuilt = true;
        return Promise.resolve({ id: 'new' });
      }),
    ).rejects.toThrow('destroy failed');
    expect(rebuilt).toBe(false);
  });
});
