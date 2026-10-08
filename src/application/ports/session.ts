import type { SessionRefValue } from '../../domain/index.js';
import type { Result } from '../../shared/index.js';
import type { AppError } from '../errors.js';

// Out-of-band operator material the at-rest key derives from. Never taken from the model.
export type SessionKeySource =
  // PIN/passphrase typed by the operator — HARDENED posture.
  | { readonly kind: 'passphrase'; readonly passphrase: string }
  // Keyfile bytes ride as a passphrase candidate against BOTH the passphrase and recovery
  // slots, so an exported recovery keyfile unlocks through this channel.
  | { readonly kind: 'keyfile'; readonly keyfilePath: string }
  // SMOOTH posture: the KEK derives from the host machine id plus each blob's salt — no
  // operator secret.
  | { readonly kind: 'machine' };

// Decrypted credentials. Never log any field of this object.
export interface SessionMaterial {
  readonly sessionRef: SessionRefValue;
  readonly secret: string;
  readonly apiId: number;
  readonly apiHash: string;
  readonly label?: string;
}

/**
 * Daemon-only write side of the encrypted session repository.
 * THE PIN IS APP-WIDE: every blob (each session plus the one sealed policy) is sealed directly
 * under the operator channels, so the PIN mutators take no session ref.
 * Posture is DERIVED from the slots a blob carries, never stored as a flag. Each mutator
 * re-encrypts every blob best-effort, so a crash mid-change may leave one blob needing
 * re-login.
 */

// SMOOTH -> HARDENED: drop the machine slot, add the passphrase slot.
export interface AddKekInput {
  readonly current: SessionKeySource;
  readonly pin: SessionKeySource;
}

// HARDENED -> HARDENED.
export interface RewrapKekInput {
  readonly current: SessionKeySource;
  readonly replacement: SessionKeySource;
}

// HARDENED -> SMOOTH: drop passphrase/recovery slots, add a machine slot.
export interface RemoveKekInput {
  readonly current: SessionKeySource;
}

// Export a recovery keyfile and add its slot; stays HARDENED.
export interface EmitRecoveryKeyfileInput {
  readonly current: SessionKeySource;
  readonly outputPath: string;
}

export interface SessionSecurityAdmin {
  addKek(input: AddKekInput): Promise<Result<void, AppError>>;
  rewrapKek(input: RewrapKekInput): Promise<Result<void, AppError>>;
  removeKek(input: RemoveKekInput): Promise<Result<void, AppError>>;
  emitRecoveryKeyfile(
    input: EmitRecoveryKeyfileInput,
  ): Promise<Result<void, AppError>>;
}

export interface SessionAdmin extends SessionSecurityAdmin {
  // Atomic write, 0600, sealed under the daemon's active key source — that is where the first
  // write fixes the posture.
  save(material: SessionMaterial): Promise<Result<void, AppError>>;
}

/**
 * The narrow port the runtime one-time unlock depends on; only `SessionGate` consumes it, so
 * the MCP tool path never gains this mutation surface. The store caches no unlocked plaintext,
 * so re-keying needs no cache invalidation.
 */
export interface RuntimeUnlockableStore {
  // Verifies a source without loading any session. Secret-free failure; the key is zeroized.
  verifyUnlock(source?: SessionKeySource): Promise<Result<void, AppError>>;
  setActiveSource(source: SessionKeySource): void;
}
