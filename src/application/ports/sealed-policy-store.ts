/**
 * SealedPolicyStore — the port to persist and retrieve the ENCRYPTED ACL policy
 * (one global blob) without knowing the envelope/slot/KEK internals. The policy
 * uses the same envelope format and active unlock source as session blobs, so
 * unlocking the store (a PIN, the machine key, or a recovery keyfile previously
 * exported for this blob) also opens the policy — no extra prompt or secret.
 * Concrete sealing lives in `EncryptedFileSessionStore`.
 *
 * Threat closed: a file-writer who edits `config.json` (widen scope, add verbs,
 * swap an endpoint API-key hash) changes NOTHING, because after unlock the
 * runtime trusts only the sealed copy — AES-256-GCM, so it cannot be forged or
 * silently edited without the unlock secret.
 */
import type { Result } from '../../shared/index.js';
import type { AppError } from '../errors.js';

export interface SealedPolicyStore {
  /**
   * Open the sealed policy blob and return its plaintext bytes (the validated
   * config JSON), or `undefined` when no blob exists yet (the runtime load fails
   * closed on that — only the explicit seal ceremony creates one). A wrong
   * secret / tampered blob fails closed with a secret-free Validation error.
   * The CALLER owns the returned buffer.
   */
  loadPolicy(): Promise<Result<Buffer | undefined, AppError>>;
  /**
   * Seal `bytes` (the validated config JSON) into the policy blob atomically
   * (0600). This runs only through explicit authenticated policy application;
   * writing the editable draft alone never invokes it.
   */
  savePolicy(bytes: Buffer): Promise<Result<void, AppError>>;
}
