/**
 * Per-request binding for the endpoint whose tool was invoked. Cross-cutting collaborators
 * (ACL, rate limiter, audit log, confirmer, clock) are injected into use-case implementations,
 * not passed here.
 */
import type {
  Endpoint,
  PermissionVerb,
  ResolvedScope,
  ChatVerbOverrideTable,
} from '../../domain/index.js';
import type { ScopedClient } from '../ports/scoped-client.js';

export interface EndpointExecutionContext {
  readonly endpoint: Endpoint;
  readonly resolvedScope: ResolvedScope;
  // Resolved per-chat verb overrides, passed to every ACL evaluation so a narrowing override
  // (read-only chat inside a writable folder) is actually enforced.
  readonly overrides: ChatVerbOverrideTable;
  // Kill-switched verbs, denied at EXECUTION before HITL and quota — even though the static
  // menu still lists the tool.
  readonly deniedVerbs: ReadonlySet<PermissionVerb>;
  readonly client: ScopedClient;
}
