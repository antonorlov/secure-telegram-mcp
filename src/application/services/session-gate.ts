/**
 * SessionGate — daemon-wide lock state plus atomic enforced-policy publication.
 *
 * The daemon serves EVERY connection while locked; endpoint resolution and the
 * tool menu are PIN-free, so initialize/tools/list always succeed. The only lock
 * chokepoint is per-tool-call gateway acquisition, which consults {@link
 * isUnlocked} and fails closed with `AppErrorCode.SessionLocked` until the FIRST
 * actor delivers the PIN. That unlock re-keys the ONE shared store and publishes
 * the ONE ENFORCED (sealed-policy) menu, after which
 * every connection's next call succeeds with no re-unlock. EXECUTION binds to the
 * enforced menu, never to the locked-window config.json draft menu.
 *
 * Depends only on the {@link RuntimeUnlockableStore} + {@link ConfigRepository}
 * ports and domain aggregates — no GramJS/socket/crypto types. The fail-closed
 * transition sequence is documented at {@link authenticateOperator}.
 */
import { isErr, ok, type Result } from '../../shared/index.js';
import type { Endpoint } from '../../domain/index.js';
import { AppErrorCode } from '../errors.js';
import type { AppError } from '../errors.js';
import type {
  ConfigRepository,
  KillSwitch,
  LoadedConfiguration,
} from '../ports/config-repository.js';
import type { SessionKeySource } from '../ports/session-key-source.js';
import type { RuntimeUnlockableStore } from '../ports/session-unlock.js';

export class SessionGate {
  private enforced: LoadedConfiguration | undefined;

  /**
   * @param store          the shared, re-keyable session store (the crypto owner).
   * @param authRepo       the ENFORCED config repository (bound to `store`, so a
   *                       re-key changes the source it verifies under).
   * @param initialEnforced the boot-validated policy; absent means locked.
   */
  public constructor(
    private readonly store: RuntimeUnlockableStore,
    private readonly authRepo: ConfigRepository,
    initialEnforced?: LoadedConfiguration,
  ) {
    this.enforced = initialEnforced;
  }

  /** Synchronous lock read derived from the enforced-policy state. */
  public isUnlocked(): boolean {
    return this.enforced !== undefined;
  }

  /** The ENFORCED endpoints (empty while locked) — the future-connection menu. */
  public enforcedEndpoints(): readonly Endpoint[] {
    return this.enforced?.endpoints ?? [];
  }

  /** Re-resolve the EXECUTION target from the ENFORCED menu by name (fail-closed). */
  public enforcedEndpoint(name: string): Endpoint | undefined {
    return this.enforced?.endpoints.find((ep) => String(ep.name) === name);
  }

  /** The ENFORCED kill-switch (undefined while locked). */
  public enforcedKillSwitch(): KillSwitch | undefined {
    return this.enforced?.killSwitch;
  }

  /** The ENFORCED global download egress cap (undefined -> gateway default). */
  public enforcedMaxDownloadBytes(): number | undefined {
    return this.enforced?.maxDownloadBytes;
  }

  /**
   * Verify the operator credential without republishing an already-unlocked
   * runtime. A locked daemon uses the normal atomic unlock transition.
   */
  public authenticateOperator(
    source: SessionKeySource,
    onPublished?: () => void,
  ): Promise<Result<void, AppError>> {
    if (this.enforced !== undefined) return this.store.verifyUnlock(source);
    return this.applyEnforcedSource(source, onPublished);
  }

  /** Publish a document already validated and durably sealed by the apply use case. */
  public publishValidated(
    config: LoadedConfiguration,
    onPublished?: () => void,
  ): void {
    this.publish(config, onPublished);
  }

  /**
   * Shared unlock/re-key core: tentatively re-key the locked store, open and
   * validate the ENFORCED policy once, then publish the menu on success. Operator
   * authentication is globally serialized; while this awaits, the locked gate
   * prevents every Telegram/session acquisition. Any failure restores machine.
   */
  private async applyEnforcedSource(
    source: SessionKeySource,
    onPublished?: () => void,
  ): Promise<Result<void, AppError>> {
    // Opening the sealed policy both authenticates the source and loads the
    // enforced menu. Do not run a separate memory-hard verification first.
    this.store.setActiveSource(source);
    let sourceAccepted = false;
    try {
      const loaded = await this.authRepo.load();
      if (isErr(loaded)) {
        if (loaded.error.code === AppErrorCode.NotFound) {
          // First run / migration can legitimately have sessions but no policy.
          // Authenticate against the representative blob before opening the gate.
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
   * ATOMIC PUBLISH — the ONE place the enforced menu is swapped (unlock or
   * policy apply): the caller's derived-cache invalidation runs SYNCHRONOUSLY in the
   * SAME frame as the swap (no `await` between), so a concurrent in-flight tool
   * call can never see the new enforced menu while a STALE derived cache still
   * governs execution — the gap where narrowing could briefly fail open.
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
