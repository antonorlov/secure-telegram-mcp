/**
 * ConfigRepository — loads the validated config and hands back DOMAIN objects
 * (Endpoints) plus the daemon-level kill-switch. The Zod schema and file I/O
 * live in infrastructure; this port exposes only the domain it produces.
 *
 * The kill-switch is a daemon-wide deny-list applied on top of every endpoint's
 * own allow-list (`endpoint.permits(verb) ∩ ¬killSwitch`) — defence in depth.
 */
import type { Result } from '../../shared/index.js';
import type { Endpoint, PermissionVerb } from '../../domain/index.js';
import type { AppError } from '../errors.js';

/** Daemon-wide deny-list intersected with each endpoint's verbs. */
export interface KillSwitch {
  readonly disabledVerbs: ReadonlySet<PermissionVerb>;
}

export interface LoadedConfiguration {
  readonly endpoints: readonly Endpoint[];
  readonly killSwitch: KillSwitch;
  /**
   * Global DOWNLOAD egress cap (bytes) for `download_media`; a resource guard, not a
   * security boundary. Undefined when the config omits it — the gateway then applies
   * its runtime default (50 MiB).
   */
  readonly maxDownloadBytes?: number;
}

export interface ConfigRepository {
  /** Parse + validate + scope-lint the config file into domain objects. */
  load(): Promise<Result<LoadedConfiguration, AppError>>;
}
