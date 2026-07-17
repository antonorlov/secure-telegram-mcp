/**
 * RuntimeUnlockableStore — the NARROW port the runtime one-time unlock depends
 * on. Only the daemon's {@link SessionGate} consumes it; the MCP tool path
 * never gains this mutation surface.
 *
 * `verifyUnlock` gates a candidate secret against a representative blob when no
 * sealed policy exists; normally the policy repository authenticates while it
 * loads the policy once. The store caches no unlocked plaintext, so re-keying
 * needs no cache invalidation.
 */
import type { Result } from '../../shared/index.js';
import type { AppError } from '../errors.js';
import type { SessionKeySource } from './session-key-source.js';

export interface RuntimeUnlockableStore {
  /**
   * Verify `source` (default: the construction-time source) unlocks the store,
   * WITHOUT loading any session. Secret-free failure; the key is zeroized.
   */
  verifyUnlock(source?: SessionKeySource): Promise<Result<void, AppError>>;
  /** Swap the active unlock source for all subsequent loads / key derivations. */
  setActiveSource(source: SessionKeySource): void;
}
