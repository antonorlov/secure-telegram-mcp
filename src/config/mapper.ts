/**
 * Builds the DECLARED scope only — the schema transforms already emitted domain values, and
 * folder/username resolution to canonical ids happens later in the data layer. Pure and
 * offline: the first invalid value fails the whole load.
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
  readonly disabledVerbs: readonly PermissionVerb[];
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
