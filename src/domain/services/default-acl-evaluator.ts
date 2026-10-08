/**
 * Pure two-gate, default-deny evaluation.
 * Gate 1 (verb): the verb must be in the target's effective set, resolved by precedence
 * chat-override > group-default > deny. Gate 2 (scope): an addressed peer must be a member of
 * the resolved allow-list. The verb gate fires first, so a call denied on both surfaces the
 * verb reason.
 */
import { DomainErrorCode } from '../errors.js';
import { AclDecisionFactory } from '../value-objects/acl-decision.js';
import type { AclDecision } from '../value-objects/acl-decision.js';
import type { PermissionVerb } from '../value-objects/permission-verb.js';
import { effectiveVerbPermits } from './effective-verb-resolver.js';
import type { ChatId } from '../value-objects/chat-id.js';
import type { ResolvedScope } from '../value-objects/resolved-scope.js';
import type { Endpoint } from '../entities/endpoint.js';
import type { ChatVerbOverrideTable } from './effective-verb-resolver.js';

export interface AclEvaluationInput {
  readonly endpoint: Endpoint;
  readonly resolvedScope: ResolvedScope;
  readonly verb: PermissionVerb;
  // Omitted for scope-wide reads, where the scoped client already constrains results to the
  // allow-list.
  readonly target?: ChatId;
  // A target's entry REPLACES the group default (chat-override > group-default > deny).
  readonly overrides?: ChatVerbOverrideTable;
  // Subtracted from the resolved effective set, so a kill-switched verb is denied even when the
  // endpoint or an override would grant it.
  readonly deniedVerbs?: ReadonlySet<PermissionVerb>;
}

export class DefaultAclEvaluator {
  public evaluate(input: AclEvaluationInput): AclDecision {
    const { resolvedScope, verb, target } = input;

    // Gate 1: a per-chat override REPLACES the group default — it can narrow or escalate.
    if (!this.permitsVerb(input, verb)) {
      return AclDecisionFactory.deny(
        verb,
        DomainErrorCode.VerbNotGranted,
        'Verb is not granted to this endpoint',
      );
    }

    // Gate 2: addressed peer must be inside the resolved allow-list. An override
    // never widens scope — an out-of-scope peer is denied even if it carries one.
    if (target !== undefined && !resolvedScope.contains(target)) {
      return AclDecisionFactory.deny(
        verb,
        DomainErrorCode.PeerOutOfScope,
        'Target peer is outside the endpoint scope',
      );
    }

    return AclDecisionFactory.allow(verb);
  }

  /**
   * Resolve the effective verb set (override > group-default) and test
   * membership; the daemon-denied set is SUBTRACTED first, so a denied verb
   * fails here even when the group/override would grant it.
   */
  private permitsVerb(input: AclEvaluationInput, verb: PermissionVerb): boolean {
    if (input.deniedVerbs?.has(verb) === true) {
      return false;
    }
    const { endpoint, target, overrides } = input;
    if (target === undefined || overrides === undefined) {
      return endpoint.permits(verb);
    }
    return effectiveVerbPermits({
      target,
      verb,
      endpoint,
      overrides,
    });
  }
}
