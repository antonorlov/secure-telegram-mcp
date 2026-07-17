/**
 * DefaultAclEvaluator — canonical pure ACL evaluation. Two-gate, DEFAULT-DENY:
 *
 *   Gate 1 (verb-gate): the verb must be in the target's EFFECTIVE verb set,
 *           resolved by precedence chat-override > group-default > deny.
 *   Gate 2 (scope-gate): an addressed target peer must be a member of the
 *           resolved allow-list.
 *
 * Both gates must pass. The verb-gate fires BEFORE the scope-gate, so a call
 * denied on both surfaces the verb reason.
 */
import { DomainErrorCode } from '../errors.js';
import { AclDecisionFactory } from '../value-objects/acl-decision.js';
import type { AclDecision } from '../value-objects/acl-decision.js';
import type { PermissionVerb } from '../value-objects/permission-verb.js';
import type { AclEvaluationInput } from './acl-evaluator.js';
import { effectiveVerbPermits } from './effective-verb-resolver.js';

export class DefaultAclEvaluator {
  public evaluate(input: AclEvaluationInput): AclDecision {
    const { resolvedScope, verb, target } = input;

    // Gate 1: verb must be in the target's resolved effective set. A per-chat
    // override REPLACES the group default — it can narrow OR escalate.
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
