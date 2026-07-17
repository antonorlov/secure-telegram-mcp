/**
 * SessionAdmin — the daemon-only write side of the encrypted session repository.
 * Setup reaches these commands only through the authenticated operator adapter.
 *
 * THE PIN IS APP-WIDE: every blob (each session + the ONE sealed policy) is
 * sealed DIRECTLY under the operator channels (machine XOR PIN, plus an optional
 * recovery slot), so the PIN mutators take no session ref — they re-key the whole
 * app.
 *
 * Posture (HARDENED vs SMOOTH) is DERIVED from the slots a blob carries, never
 * stored as a flag. Each posture-changing mutator DECRYPTS-AND-RE-ENCRYPTS every
 * blob under the new slot set, each written atomically, best-effort per blob (a
 * crash mid-change may leave one blob needing re-login). The HARD INVARIANT —
 * hardened carries NO machine slot — is enforced at write time, so there is no
 * silent-downgrade path. Callers speak only in `SessionKeySource` and
 * `SessionMaterial`.
 */
import type { Result } from '../../shared/index.js';
import type { AppError } from '../errors.js';
import type { SessionMaterial } from '../dtos/session-material.js';
import type { SessionKeySource } from './session-key-source.js';

/** Set the app PIN (SMOOTH -> HARDENED): drop the machine slot, add the passphrase slot. */
export interface AddKekInput {
  /** The current unlock secret (typically a machine source when SMOOTH). */
  readonly current: SessionKeySource;
  /** The new PIN slot to seal under (passphrase, or keyfile-as-passphrase). */
  readonly pin: SessionKeySource;
}

/** Change the app PIN (HARDENED -> HARDENED). */
export interface RewrapKekInput {
  /** The current unlock secret (the existing PIN). */
  readonly current: SessionKeySource;
  /** The replacement PIN slot. */
  readonly replacement: SessionKeySource;
}

/** Remove the app PIN (HARDENED -> SMOOTH): drop passphrase/recovery slots, add a machine slot. */
export interface RemoveKekInput {
  /** The current unlock secret (the existing PIN). */
  readonly current: SessionKeySource;
}

/** Export a recovery keyfile and add its recovery slot (stays HARDENED). */
export interface EmitRecoveryKeyfileInput {
  /** The current unlock secret (the existing PIN). */
  readonly current: SessionKeySource;
  /** Destination for the 0600 recovery keyfile written by the implementation. */
  readonly outputPath: string;
}

export interface SessionSecurityAdmin {
  /** Set the app PIN. Re-seals every blob directly under the new PIN slot. */
  addKek(input: AddKekInput): Promise<Result<void, AppError>>;
  /** Change the app PIN. Re-seals every blob directly under the new PIN slot. */
  rewrapKek(input: RewrapKekInput): Promise<Result<void, AppError>>;
  /** Remove the app PIN. Re-seals every blob directly under a machine slot. */
  removeKek(input: RemoveKekInput): Promise<Result<void, AppError>>;
  /** Export one recovery keyfile + add its slot to every blob present now. */
  emitRecoveryKeyfile(
    input: EmitRecoveryKeyfileInput,
  ): Promise<Result<void, AppError>>;
}

export interface SessionAdmin extends SessionSecurityAdmin {
  /**
   * Encrypt & persist a session blob with 0600 perms (atomic write), sealed
   * DIRECTLY under the daemon's active key source (that is where the chosen
   * posture lands on the very first write).
   */
  save(material: SessionMaterial): Promise<Result<void, AppError>>;
}
