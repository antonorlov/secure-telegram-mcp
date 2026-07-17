/**
 * Per-chat verb resolution. Precedence enforced by the ACL evaluator and
 * mirrored by the picker:
 *
 *     chat-override  >  group-default  >  deny
 *
 * A chat with an explicit override uses its OWN verb set; a chat with none
 * INHERITS the group default; a verb in neither set is denied (default-deny).
 */
import type { PermissionVerb } from '../value-objects/permission-verb.js';
import type { ChatId } from '../value-objects/chat-id.js';
import type { Endpoint } from '../entities/endpoint.js';

/** Override table keyed by `ChatId.toKey()` for O(1) lookup at evaluation. */
export type ChatVerbOverrideTable = ReadonlyMap<string, ReadonlySet<PermissionVerb>>;

/**
 * Test one verb against the target override when present, otherwise against the
 * endpoint default. This is the precedence SSOT and allocates nothing per call.
 */
export const effectiveVerbPermits = (input: {
  readonly target: ChatId;
  readonly verb: PermissionVerb;
  readonly endpoint: Endpoint;
  readonly overrides: ChatVerbOverrideTable;
}): boolean => {
  const override = input.overrides.get(input.target.toKey());
  return override === undefined
    ? input.endpoint.permits(input.verb)
    : override.has(input.verb);
};

/**
 * Post-resolution enforcement predicate, KEYED form (peer already resolved to
 * its canonical id key). Speaks ONLY to the override layer: a chat with no
 * override returns `true` (deferring to the group-default gate upstream); a
 * chat WITH an override must contain `verb` (the override narrows as well as
 * escalates). Pure, total.
 */
export const chatOverridePermitsVerb = (input: {
  readonly key: string;
  readonly verb: PermissionVerb;
  readonly overrides: ChatVerbOverrideTable;
}): boolean => {
  const override = input.overrides.get(input.key);
  return override === undefined || override.has(input.verb);
};
