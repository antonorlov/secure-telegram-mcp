/**
 * EndpointExecutionContext — the per-request binding a use-case operates within.
 * Created by the composition root for the endpoint whose tool was invoked; it
 * carries the endpoint aggregate, its resolved allow-list, and the scoped client.
 * Cross-cutting collaborators (the ACL evaluator, RateLimiter, AuditLog,
 * Confirmer, Clock) are injected into use-case IMPLEMENTATIONS via their
 * constructors, not passed here — keeping this context small.
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
  /**
   * The endpoint's RESOLVED per-chat verb overrides (keyed by canonical id),
   * empty for the common pure-group-default case. Passed to every ACL
   * `evaluate()` so a narrowing override (e.g. a read-only chat inside a writable
   * folder) is actually ENFORCED, never a silently-inert control.
   */
  readonly overrides: ChatVerbOverrideTable;
  /**
   * The DAEMON-DENIED verb set for this call (the operator kill switch,
   * `killSwitch.disabledVerbs`), composed once when the context is resolved.
   * Consumed by every ACL `evaluate()` so a kill-switched verb is denied at
   * EXECUTION — BEFORE HITL/quota — even though the STATIC menu still lists
   * its tool.
   */
  readonly deniedVerbs: ReadonlySet<PermissionVerb>;
  readonly client: ScopedClient;
}
