/**
 * Per-chat verb resolution, precedence chat-override > group-default > deny: a chat with an
 * explicit override uses its OWN verb set, one without inherits the group default, and a verb
 * in neither is denied.
 */
import type { PermissionVerb } from '../value-objects/permission-verb.js';
import type { ChatId } from '../value-objects/chat-id.js';
import type { Endpoint } from '../entities/endpoint.js';

// Override table keyed by `ChatId.toKey()` for O(1) lookup at evaluation.
export type ChatVerbOverrideTable = ReadonlyMap<string, ReadonlySet<PermissionVerb>>;

// The precedence SSOT — it allocates nothing per call.
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
 * Keyed form, speaking ONLY to the override layer: a chat with no override returns `true`,
 * deferring to the group-default gate upstream, while a chat with an override must contain the
 * verb.
 */
export const chatOverridePermitsVerb = (input: {
  readonly key: string;
  readonly verb: PermissionVerb;
  readonly overrides: ChatVerbOverrideTable;
}): boolean => {
  const override = input.overrides.get(input.key);
  return override === undefined || override.has(input.verb);
};
