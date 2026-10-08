/**
 * Daemon-wide lock state plus atomic publication of the enforced policy.
 * The daemon serves every connection while locked — initialize and tools/list are PIN-free. The
 * only chokepoint is per-tool-call gateway acquisition, which fails closed with `SessionLocked`
 * until the first actor delivers the PIN. Execution binds to the ENFORCED sealed-policy menu,
 * never to the config.json draft.
 */
import { isErr, ok, type Result } from '../../shared/index.js';
import type { Endpoint } from '../../domain/index.js';
import { AppErrorCode } from '../errors.js';
import type { AppError } from '../errors.js';
import type {
  ConfigRepository,
  KillSwitch,
  LoadedConfiguration,
} from '../ports/configuration.js';
import type { SessionKeySource, RuntimeUnlockableStore } from '../ports/session.js';

export class SessionGate {
  private enforced: LoadedConfiguration | undefined;

  public constructor(
    private readonly store: RuntimeUnlockableStore,
    private readonly authRepo: ConfigRepository,
    initialEnforced?: LoadedConfiguration,
  ) {
    this.enforced = initialEnforced;
  }

  public isUnlocked(): boolean {
    return this.enforced !== undefined;
  }

  public enforcedEndpoints(): readonly Endpoint[] {
    return this.enforced?.endpoints ?? [];
  }

  public enforcedEndpoint(name: string): Endpoint | undefined {
    return this.enforced?.endpoints.find((ep) => String(ep.name) === name);
  }

  public enforcedKillSwitch(): KillSwitch | undefined {
    return this.enforced?.killSwitch;
  }

  public enforcedMaxDownloadBytes(): number | undefined {
    return this.enforced?.maxDownloadBytes;
  }

  // Verifies the operator credential without republishing an already-unlocked runtime.
  public authenticateOperator(
    source: SessionKeySource,
    onPublished?: () => void,
  ): Promise<Result<void, AppError>> {
    if (this.enforced !== undefined) return this.store.verifyUnlock(source);
    return this.applyEnforcedSource(source, onPublished);
  }

  public publishValidated(
    config: LoadedConfiguration,
    onPublished?: () => void,
  ): void {
    this.publish(config, onPublished);
  }

  /**
   * Tentatively re-keys the locked store, opens and validates the enforced policy once, then
   * publishes. Operator authentication is globally serialized; any failure restores the machine
   * source.
   */
  private async applyEnforcedSource(
    source: SessionKeySource,
    onPublished?: () => void,
  ): Promise<Result<void, AppError>> {
    // Opening the sealed policy both authenticates the source and loads the enforced menu — do
    // not run a separate memory-hard verification first.
    this.store.setActiveSource(source);
    let sourceAccepted = false;
    try {
      const loaded = await this.authRepo.load();
      if (isErr(loaded)) {
        if (loaded.error.code === AppErrorCode.NotFound) {
          // First run or migration can legitimately have sessions but no policy: authenticate
          // against a representative blob before opening the gate.
          const verified = await this.store.verifyUnlock(source);
          if (isErr(verified)) return verified;
          sourceAccepted = true;
          this.publish(
            { endpoints: [], killSwitch: { disabledVerbs: new Set() } },
            onPublished,
          );
          return ok(undefined);
        }
        return loaded;
      }
      sourceAccepted = true;
      this.publish(loaded.value, onPublished);
      return ok(undefined);
    } finally {
      if (!sourceAccepted) this.store.setActiveSource({ kind: 'machine' });
    }
  }

  /**
   * ATOMIC PUBLISH — the one place the enforced menu is swapped. The caller's cache
   * invalidation runs synchronously in the same frame as the swap (no `await` between), so an
   * in-flight call can never execute against a stale cache while the new menu is live.
   * `onPublished` MUST be synchronous.
   */
  private publish(
    config: LoadedConfiguration,
    onPublished?: () => void,
  ): void {
    this.enforced = config;
    onPublished?.();
  }
}
