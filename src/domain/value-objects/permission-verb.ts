/**
 * PermissionVerb — the decomposed capability vocabulary. A verb is the unit the
 * tool registry keys on: a tool is registered for an endpoint only if its group
 * grants the verb. (An admin tier existed here unshipped; it returns together
 * with the first admin tool.)
 *
 * TIERS SPLIT AT OBSERVABILITY. The read tier is PASSIVE — a read verb has zero
 * externally-visible effect on the account (`read`, `read_media`).
 * `read_media` is the media-EGRESS opt-in (downloading bytes to disk): it rides
 * inside a read grant but is separately strippable (explicit verb list, per-chat
 * override, or kill-switch), so a text-only endpoint denies downloads. Everything
 * that DOES something observable is a write verb — including `mark_read` (it fires
 * read receipts) and the lightweight `react`.
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

/** A verb that only observes state. */
export const isReadVerb = (verb: PermissionVerb): boolean => READ_VERBS.has(verb);

/**
 * A verb that mutates Telegram state; subject to write quota + HITL. The exact
 * complement of the read tier, so a future verb is a WRITE (HITL'd, quota'd)
 * unless explicitly declared passive — fail-closed by default.
 */
export const isWriteVerb = (verb: PermissionVerb): boolean => !isReadVerb(verb);

export const isPermissionVerb = (v: unknown): v is PermissionVerb =>
  typeof v === 'string' &&
  (ALL_PERMISSION_VERBS as readonly string[]).includes(v);
