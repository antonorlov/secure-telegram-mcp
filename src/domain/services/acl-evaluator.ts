/**
 * AclEvaluationInput — the input shape of the pure ACL decision: an endpoint,
 * its resolved allow-list, the requested verb and (optionally) a target peer.
 * The decision function itself is {@link DefaultAclEvaluator}. No I/O.
 */
import type { PermissionVerb } from '../value-objects/permission-verb.js';
import type { ChatId } from '../value-objects/chat-id.js';
import type { ResolvedScope } from '../value-objects/resolved-scope.js';
import type { Endpoint } from '../entities/endpoint.js';
import type { ChatVerbOverrideTable } from './effective-verb-resolver.js';

export interface AclEvaluationInput {
  readonly endpoint: Endpoint;
  /** The endpoint's fully-resolved allow-list (folders already expanded). */
  readonly resolvedScope: ResolvedScope;
  readonly verb: PermissionVerb;
  /**
   * The target peer, when the operation addresses a specific peer. Omitted for
   * scope-wide reads (e.g. list_dialogs), where the scoped client already
   * constrains results to the allow-list.
   */
  readonly target?: ChatId;
  /**
   * The endpoint's RESOLVED per-chat verb overrides, keyed by `ChatId.toKey()`.
   * When a target has an entry, its verb set REPLACES the group default
   * (chat-override > group-default > deny). Omitted/empty = pure group-default.
   */
  readonly overrides?: ChatVerbOverrideTable;
  /**
   * The daemon-denied verb set (`killSwitch.disabledVerbs`, composed at the
   * endpoint-stack composition site), SUBTRACTED from the resolved effective
   * set so a kill-switched verb is denied even when the endpoint/override
   * would grant it. Omitted = nothing denied.
   */
  readonly deniedVerbs?: ReadonlySet<PermissionVerb>;
}

