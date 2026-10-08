/**
 * A verb is the unit the tool registry keys on — a tool is registered for an endpoint only if
 * its group grants the verb.
 * TIERS SPLIT AT OBSERVABILITY: the read tier is passive, and everything with an externally
 * visible effect is a write. `read_media` is the media-egress opt-in — it rides inside a read
 * grant but stays separately strippable, so a text-only endpoint denies downloads.
 */

export const PermissionVerb = {
  // read tier — PASSIVE (no externally-visible effect)
  Read: 'read',
  ReadMedia: 'read_media',
  // write tier (each observable to others / the account)
  Send: 'send',
  Draft: 'draft',
  Delete: 'delete',
  // mark_read fires read receipts — an observable effect, so a WRITE verb.
  MarkRead: 'mark_read',
  Forward: 'forward',
  React: 'react',
} as const;

export type PermissionVerb = (typeof PermissionVerb)[keyof typeof PermissionVerb];

export const ALL_PERMISSION_VERBS: readonly PermissionVerb[] = Object.freeze(
  Object.values(PermissionVerb),
);

const READ_VERBS: ReadonlySet<PermissionVerb> = new Set<PermissionVerb>([
  PermissionVerb.Read,
  PermissionVerb.ReadMedia,
]);

export const isReadVerb = (verb: PermissionVerb): boolean => READ_VERBS.has(verb);

// The exact complement of the read tier, so a future verb counts as a write — quota'd and
// HITL'd — unless explicitly declared passive.
export const isWriteVerb = (verb: PermissionVerb): boolean => !isReadVerb(verb);

export const isPermissionVerb = (v: unknown): v is PermissionVerb =>
  typeof v === 'string' &&
  (ALL_PERMISSION_VERBS as readonly string[]).includes(v);
