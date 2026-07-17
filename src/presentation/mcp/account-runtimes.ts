/** One independently-retired connection owner per Telegram session reference. */
export class AccountRuntimes<TRuntime> {
  private readonly current = new Map<string, Promise<TRuntime>>();
  private readonly retired = new Map<string, Promise<void>>();

  public constructor(
    private readonly dispose: (runtime: TRuntime) => Promise<void>,
  ) {}

  public get(
    sessionRef: string,
    build: () => Promise<TRuntime>,
  ): Promise<TRuntime> {
    const existing = this.current.get(sessionRef);
    if (existing !== undefined) return existing;

    const barrier = this.retired.get(sessionRef) ?? Promise.resolve();
    const building = (async (): Promise<TRuntime> => {
      await barrier;
      return build();
    })();
    this.current.set(sessionRef, building);
    building.catch(() => {
      if (this.current.get(sessionRef) === building) {
        this.current.delete(sessionRef);
      }
    });
    return building;
  }

  /**
   * Hold the session-ref barrier across an account mutation. New builds wait for
   * old ownership disposal and the complete mutation.
   */
  public withRetired<T>(
    sessionRef: string,
    work: () => Promise<T>,
    beforeDispose?: () => Promise<void>,
  ): Promise<T> {
    const runtime = this.current.get(sessionRef);
    this.current.delete(sessionRef);
    const prior = this.retired.get(sessionRef) ?? Promise.resolve();
    const running = prior.then(async () => {
      await beforeDispose?.();
      if (runtime !== undefined) {
        const built = await runtime.catch(() => undefined);
        if (built !== undefined) await this.dispose(built);
      }
      return work();
    });
    const barrier = running.then(() => undefined);
    void barrier.catch(() => undefined);
    this.retired.set(sessionRef, barrier);
    void barrier
      .then(() => {
        if (this.retired.get(sessionRef) === barrier) {
          this.retired.delete(sessionRef);
        }
      })
      .catch(() => undefined);
    return running;
  }

  /** Shutdown barrier: no account runtime survives its resolution. */
  public async retireAll(): Promise<void> {
    const refs = [...this.current.keys()];
    await Promise.all(
      refs.map((ref) => this.withRetired(ref, () => Promise.resolve())),
    );
    await Promise.all(this.retired.values());
  }
}
