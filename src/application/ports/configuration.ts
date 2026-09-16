import type { Result } from '../../shared/index.js';
import type { Endpoint, PermissionVerb } from '../../domain/index.js';
import type { AppError } from '../errors.js';

// Loads the validated config and hands back domain objects. The kill-switch is a daemon-wide
// deny-list intersected with every endpoint's own allow-list — defence in depth.
export interface KillSwitch {
  readonly disabledVerbs: ReadonlySet<PermissionVerb>;
}

export interface LoadedConfiguration {
  readonly endpoints: readonly Endpoint[];
  readonly killSwitch: KillSwitch;
  // A resource guard, not a security boundary; undefined means the gateway default (50 MiB).
  readonly maxDownloadBytes?: number;
}

export interface ConfigRepository {
  load(): Promise<Result<LoadedConfiguration, AppError>>;
}

export interface ConfigDocumentParser {
  loadFromParsed(json: unknown): Result<LoadedConfiguration, AppError>;
}

/**
 * The ACL policy sealed as ONE encrypted blob under the same slots as session blobs, so
 * unlocking a session also opens it.
 * Editing `config.json` changes nothing after unlock: the runtime trusts only the sealed copy,
 * and AES-256-GCM means it cannot be forged or silently edited.
 */
export interface SealedPolicyStore {
  // `undefined` when no blob exists yet — the runtime load fails closed on that. A wrong secret
  // or tampered blob also fails closed, secret-free. The caller owns the buffer.
  loadPolicy(): Promise<Result<Buffer | undefined, AppError>>;
  // Runs only through authenticated policy application; writing the editable draft never seals.
  savePolicy(bytes: Buffer): Promise<Result<void, AppError>>;
}
