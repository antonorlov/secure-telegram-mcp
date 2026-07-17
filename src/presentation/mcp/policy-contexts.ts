/** Policy-derived contexts retire without closing their shared account connection. */
export class PolicyContexts<TContext> {
  private readonly current = new Map<string, Promise<TContext>>();
  private retired: Promise<void> = Promise.resolve();

  public constructor(
    private readonly dispose: (context: TContext) => Promise<void>,
    private readonly onFailure: (reason: string) => void,
  ) {}

  public barrier(): Promise<void> {
    return this.retired;
  }

  /** Share one build per endpoint and evict only the promise that failed. */
  public get(key: string, build: () => Promise<TContext>): Promise<TContext> {
    const existing = this.current.get(key);
    if (existing !== undefined) return existing;

    const building = Promise.resolve().then(build);
    this.current.set(key, building);
    building.catch(() => {
      if (this.current.get(key) === building) this.current.delete(key);
    });
    return building;
  }

  /** Remove selected bindings synchronously, or all when keys are omitted. */
  public retire(keys?: ReadonlySet<string>): void {
    const contexts: Promise<TContext>[] = [];
    for (const [key, context] of this.current) {
      if (keys === undefined || keys.has(key)) {
        contexts.push(context);
        this.current.delete(key);
      }
    }
    if (contexts.length === 0) return;

    const prior = this.retired;
    const retiring = (async (): Promise<void> => {
      await prior.catch(() => undefined);
      const settled = await Promise.allSettled(contexts);
      const disposals = await Promise.allSettled(
        settled.flatMap((result) =>
          result.status === 'fulfilled' ? [this.dispose(result.value)] : [],
        ),
      );
      const failed = disposals.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failed !== undefined) {
        const error =
          failed.reason instanceof Error
            ? failed.reason
            : new Error('scoped binding teardown failed');
        this.onFailure(error.message);
        throw error;
      }
    })();
    void retiring.catch(() => undefined);
    this.retired = retiring;
  }
}
