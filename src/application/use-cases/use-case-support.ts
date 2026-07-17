/**
 * Use-case support — small, pure helpers shared by the read/write use-case
 * engines. No I/O; only mapping between domain decisions, peer references and the
 * application-layer error/audit vocabularies.
 */
import {
  AclDecisionFactory,
  DomainErrorCode,
  domainError,
} from '../../domain/index.js';
import type {
  AclDecision,
  DefaultAclEvaluator,
  ChatId,
  ChatVerbOverrideTable,
  Endpoint,
  EndpointNameValue,
  PeerRef,
  PermissionVerb,
  ResolvedScope,
} from '../../domain/index.js';
import type { Clock } from '../ports/clock.js';
import type { AuditRecord } from '../ports/audit-log.js';
import { AppErrorCode, appError, type AppError } from '../errors.js';

/** The deny branch of an AclDecision. */
export type AclDenial = Extract<AclDecision, { readonly allowed: false }>;

/** Primary canonical-id string of a peer for audit/HITL, when known up-front. */
export const primaryKeyOf = (peer?: PeerRef): string | undefined =>
  peer?.kind === 'id' ? peer.id.toKey() : undefined;

/** The ACL-relevant slice of an execution context (what `evaluate()` consumes). */
export interface AclContextFields {
  readonly endpoint: Endpoint;
  readonly resolvedScope: ResolvedScope;
  readonly overrides: ChatVerbOverrideTable;
  readonly deniedVerbs: ReadonlySet<PermissionVerb>;
}

/**
 * The ONE spelling of the 6-field ACL `evaluate()` input (honouring
 * exactOptionalPropertyTypes: `target` is spread only when present). Every ACL
 * call in this module funnels through here so the security chokepoint's call
 * shape cannot drift between sites.
 */
const evalOne = (
  acl: DefaultAclEvaluator,
  ctx: AclContextFields,
  verb: PermissionVerb,
  target?: ChatId,
): AclDecision =>
  acl.evaluate({
    endpoint: ctx.endpoint,
    resolvedScope: ctx.resolvedScope,
    overrides: ctx.overrides,
    deniedVerbs: ctx.deniedVerbs,
    verb,
    ...(target !== undefined ? { target } : {}),
  });

/** First denied target; `target` is absent for a scope-wide no-target eval. */
export interface AclFailure {
  readonly target?: ChatId;
  readonly decision: AclDenial;
}

/**
 * The per-call ACL fan-out shared by the read/write engines: evaluate each `id`
 * target against ITS verb (`targetVerbs` aligned 1:1 with `targets`, e.g.
 * forward = read(src)+forward(dst); default `verb` for every target), or run a
 * SINGLE no-target evaluation for a scope-wide op (verb gate only — scope is
 * enforced physically by the scoped data layer), in target order. Callers deny
 * on the first `!allowed` decision (fail-closed); the paired `target` lets the
 * write engine audit the FAILING side.
 */
export const firstAclFailure = (
  acl: DefaultAclEvaluator,
  ctx: AclContextFields,
  check: {
    readonly verb: PermissionVerb;
    readonly targets: readonly ChatId[];
    readonly targetVerbs?: readonly PermissionVerb[];
  },
): AclFailure | undefined => {
  if (check.targets.length === 0) {
    const decision = evalOne(acl, ctx, check.verb);
    return decision.allowed ? undefined : { decision };
  }
  for (let i = 0; i < check.targets.length; i += 1) {
    const target = check.targets[i];
    if (target === undefined) continue;
    const decision = evalOne(
      acl,
      ctx,
      check.targetVerbs?.[i] ?? check.verb,
      target,
    );
    if (!decision.allowed) return { target, decision };
  }
  return undefined;
};

/**
 * OR-gate over the WHOLE resolved scope for a PEER-LESS op (e.g. `prepare_media`,
 * which mints a scope+session+TTL-bound handle with NO Telegram side effect and
 * NO specific target). Returns ALLOW as soon as ANY in-scope chat's effective set
 * permits `verb` (group grant ∪ any per-chat override, minus daemon-denied), else
 * the last DENY (fail-closed). This decides only whether the endpoint can `verb`
 * ANYWHERE; the concrete send (`send_media`) still re-gates its specific target
 * per-chat, so a read-only-group endpoint with a single per-chat Send override can
 * prepare AND send media to that one chat while every other chat still denies.
 * `ResolvedScope` is non-empty by construction, so the post-loop deny is an
 * unreachable type-level fallback.
 */
export const permitsVerbForAnyReachableTarget = (
  acl: DefaultAclEvaluator,
  ctx: AclContextFields,
  verb: PermissionVerb,
): AclDecision => {
  let lastDenial: AclDecision | undefined;
  for (const target of ctx.resolvedScope.toArray()) {
    const decision = evalOne(acl, ctx, verb, target);
    if (decision.allowed) {
      return decision;
    }
    lastDenial = decision;
  }
  return (
    lastDenial ??
    AclDecisionFactory.deny(
      verb,
      DomainErrorCode.VerbNotGranted,
      'Verb is not granted to any in-scope chat',
    )
  );
};

/** Map an ACL denial to the application-layer ACL_DENIED error (carrying cause). */
export const aclDeniedError = (denial: AclDenial): AppError =>
  appError(AppErrorCode.AclDenied, denial.message, {
    cause: domainError(denial.reason, denial.message),
  });

/** Outcome + optional structured detail for an audit record (no untrusted prose). */
export interface AuditDetail {
  readonly outcome: 'allow' | 'deny';
  readonly targetChatId?: string;
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

/** Build an immutable AuditRecord, honouring exactOptionalPropertyTypes. */
export const buildAuditRecord = (
  clock: Clock,
  endpointName: EndpointNameValue,
  verb: PermissionVerb,
  detail: AuditDetail,
): AuditRecord =>
  Object.freeze({
    timestampIso: clock.nowIso(),
    endpointName,
    verb,
    outcome: detail.outcome,
    ...(detail.targetChatId !== undefined
      ? { targetChatId: detail.targetChatId }
      : {}),
    ...(detail.reason !== undefined ? { reason: detail.reason } : {}),
    ...(detail.idempotencyKey !== undefined
      ? { idempotencyKey: detail.idempotencyKey }
      : {}),
  });
