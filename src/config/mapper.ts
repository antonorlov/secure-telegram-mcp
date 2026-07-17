/**
 * Config -> domain mapper. Builds the DECLARED scope only — the schema's
 * transforms already emit domain `PeerRef`/`FolderRef`/override values through
 * the domain factories, so this step just assembles them into `Endpoint`
 * entities. Folder/username RESOLUTION to canonical ids happens later, in the
 * data layer. Pure & offline; returns a Result and the first invalid value
 * fails the whole load (fail-closed).
 */
import { type Result, ok, isErr } from '../shared/index.js';
import {
  Endpoint,
  EndpointName,
  SessionRef,
  Scope,
  type PermissionVerb,
  type DomainError,
} from '../domain/index.js';
import type { ValidatedConfig } from './schema.js';

export interface MappedConfig {
  readonly endpoints: readonly Endpoint[];
  /** Daemon-wide kill-switch deny-list (domain verbs). */
  readonly disabledVerbs: readonly PermissionVerb[];
  /** Global download egress cap (bytes); undefined -> runtime default. */
  readonly maxDownloadBytes?: number;
}

export const mapConfigToDomain = (
  cfg: ValidatedConfig,
): Result<MappedConfig, DomainError> => {
  const endpoints: Endpoint[] = [];

  for (const ep of cfg.endpoints) {
    const name = EndpointName.create(ep.name);
    if (isErr(name)) {
      return name;
    }
    const sessionRef = SessionRef.create(ep.session);
    if (isErr(sessionRef)) {
      return sessionRef;
    }

    // Scope chats/folders and the per-chat verb overrides are already domain
    // values (validated by the factories inside the schema transforms); the
    // declared overrides are carried onto the endpoint for the runtime to resolve.
    endpoints.push(
      Endpoint.create({
        name: name.value,
        scope: Scope.create(ep.scope.chats, ep.scope.folders),
        verbs: ep.verbs,
        chatOverrides: ep.scope.chatOverrides,
        sessionRef: sessionRef.value,
        confirmWrites: ep.hitl.confirmWrites,
        tokenHash: ep.tokenHash,
      }),
    );
  }

  return ok({
    endpoints: Object.freeze(endpoints),
    disabledVerbs: Object.freeze([...cfg.killSwitch.disabledVerbs]),
    ...(cfg.maxDownloadBytes !== undefined
      ? { maxDownloadBytes: cfg.maxDownloadBytes }
      : {}),
  });
};
