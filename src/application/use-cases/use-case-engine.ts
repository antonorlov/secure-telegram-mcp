/**
 * The shared read/write orchestration behind every tool's use-case.
 * READ: resolve peers -> ACL -> optional gate (read-side quota) -> scoped read. A denied read
 * audits DENY and fails closed BEFORE the gate, so a doomed read never draws quota; successful
 * reads are not audited.
 * WRITE: ACL -> HITL -> quota -> run -> audit. That order matters: a declined write must spend
 * no anti-ban quota, since the port has no refund.
 */
import { err, ok, type Result } from '../../shared/index.js';
import { PermissionVerb } from '../../domain/index.js';
import type { ChatId, DefaultAclEvaluator, PeerRef } from '../../domain/index.js';
import type { Clock } from '../ports/clock.js';
import type { AuditLog } from '../ports/audit-log.js';
import type { RateLimiter, QuotaBucket } from '../ports/rate-limiter.js';
import type { Confirmer } from '../ports/confirmer.js';
import type { ScopedReader, ScopedWriter } from '../ports/scoped-client.js';
import { AppErrorCode, appError, type AppError } from '../errors.js';
import type { UseCase } from './use-case.js';
import type { EndpointExecutionContext } from './context.js';
import {
  aclDeniedError,
  buildAuditRecord,
  firstAclFailure,
  primaryKeyOf,
} from './use-case-support.js';

export interface ReadUseCaseDeps {
  readonly aclEvaluator: DefaultAclEvaluator;
  readonly auditLog: AuditLog;
  readonly clock: Clock;
  // Anti-ban limiter: only the search gate consumes read-side quota.
  readonly rateLimiter: RateLimiter;
}

export interface WriteUseCaseDeps extends ReadUseCaseDeps {
  readonly confirmer: Confirmer;
}

// Resolve each `PeerRef` through the scoped client (fail-closed, in order).
const resolveTargets = async (
  ctx: EndpointExecutionContext,
  peers: readonly PeerRef[],
): Promise<Result<readonly ChatId[], AppError>> => {
  const targets: ChatId[] = [];
  for (const peer of peers) {
    const resolved = await ctx.client.resolvePeer(peer);
    if (!resolved.ok) {
      return err(resolved.error);
    }
    targets.push(resolved.value);
  }
  return ok(Object.freeze(targets));
};

interface AuditExtra {
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

interface SinglePeerInput {
  readonly peer: PeerRef;
}

interface ResolvedPeerHooks<TInput> {
  readonly peers: (input: TInput) => readonly PeerRef[];
  readonly targetKey: (input: TInput) => string | undefined;
}

// Peer hooks default to the single-peer shape; inputs that do not carry `peer: PeerRef`
// (scope-wide reads, forward's two peers) must spell both out — a compile-time constraint.
type PeerHooks<TInput> = TInput extends SinglePeerInput
  ? Partial<ResolvedPeerHooks<TInput>>
  : ResolvedPeerHooks<TInput>;

const peerHooksOf = <TInput>(
  spec: PeerHooks<TInput>,
): ResolvedPeerHooks<TInput> => ({
  // The defaults are reachable only when TInput extends SinglePeerInput, so the assertions are
  // sound; a mistake still fails closed at resolvePeer.
  peers:
    spec.peers ??
    ((input): readonly PeerRef[] => [(input as TInput & SinglePeerInput).peer]),
  targetKey:
    spec.targetKey ??
    ((input): string | undefined =>
      primaryKeyOf((input as TInput & SinglePeerInput).peer)),
});

// `gate` is the only hook: a read that amplifies into many gateway calls (the search fan-out)
// reserves read-side quota here, post-ACL.
export type ReadSpec<TInput, TOutput> = PeerHooks<TInput> & {
  // Default `read`; a media-egress read declares `read_media`, which the scoped data layer
  // re-checks per chat.
  readonly verb?: PermissionVerb;
  readonly run: (
    reader: ScopedReader,
    input: TInput,
  ) => Promise<Result<TOutput, AppError>>;
  readonly gate?: (
    ctx: EndpointExecutionContext,
    input: TInput,
    deps: ReadUseCaseDeps,
  ) => Promise<Result<void, AppError>>;
  // Appends an ALLOW record on success — the read log otherwise records only denials.
  readonly auditSuccess?: boolean;
};

export const makeReadUseCase = <TInput, TOutput>(
  deps: ReadUseCaseDeps,
  spec: ReadSpec<TInput, TOutput>,
): UseCase<TInput, TOutput> => {
  const verb = spec.verb ?? PermissionVerb.Read;
  const { peers, targetKey: targetKeyOf } = peerHooksOf<TInput>(spec);
  const auditDeny = (
    ctx: EndpointExecutionContext,
    targetKey: string | undefined,
    reason: string,
  ): Promise<Result<void, AppError>> =>
    deps.auditLog.append(
      buildAuditRecord(deps.clock, ctx.endpoint.name, verb, {
        outcome: 'deny',
        reason,
        ...(targetKey !== undefined ? { targetChatId: targetKey } : {}),
      }),
    );

  return {
    verb,
    async execute(ctx, input): Promise<Result<TOutput, AppError>> {
      const resolvedTargets = await resolveTargets(ctx, peers(input));
      const targetKey =
        targetKeyOf(input) ??
        (resolvedTargets.ok && resolvedTargets.value.length === 1
          ? resolvedTargets.value[0]?.toKey()
          : undefined);

      if (!resolvedTargets.ok) {
        await auditDeny(ctx, targetKey, resolvedTargets.error.code);
        return err(resolvedTargets.error);
      }

      const failure = firstAclFailure(deps.aclEvaluator, ctx, {
        verb,
        targets: resolvedTargets.value,
      });
      if (failure !== undefined) {
        await auditDeny(ctx, targetKey, failure.decision.reason);
        return err(aclDeniedError(failure.decision));
      }

      // Post-ACL so a denied request never draws quota; a refusal is a DENY audit record.
      if (spec.gate !== undefined) {
        const gated = await spec.gate(ctx, input, deps);
        if (!gated.ok) {
          await auditDeny(ctx, targetKey, gated.error.code);
          return err(gated.error);
        }
      }

      const result = await spec.run(ctx.client, input);
      // A sink failure is loud but must not turn an already-completed download into a false
      // failure.
      if (spec.auditSuccess === true && result.ok) {
        await deps.auditLog.append(
          buildAuditRecord(deps.clock, ctx.endpoint.name, verb, {
            outcome: 'allow',
            ...(targetKey !== undefined ? { targetChatId: targetKey } : {}),
          }),
        );
      }
      return result;
    },
  };
};

export type WriteSpec<TInput, TOutput> = PeerHooks<TInput> & {
  readonly verb: PermissionVerb;
  readonly bucket: QuotaBucket;
  // Operator-facing and structured — never untrusted prose.
  readonly description: string;
  // Per-target verbs for a command that reads one peer and writes another: forward needs `read`
  // on the source and `forward` on the destination. Quota, HITL and the audit verb stay `verb`.
  readonly peerVerbs?: (input: TInput) => readonly PermissionVerb[];
  readonly run: (
    writer: ScopedWriter,
    input: TInput,
  ) => Promise<Result<TOutput, AppError>>;
  // Forward overrides this to pick its DESTINATION, so the approver sees where the message
  // goes.
  readonly fallbackTargetKey?: (
    targets: readonly ChatId[],
  ) => string | undefined;
  readonly auditKey?: (output: TOutput) => string | undefined;
};

const defaultFallbackTargetKey = (
  targets: readonly ChatId[],
): string | undefined => (targets.length === 1 ? targets[0]?.toKey() : undefined);

export const makeWriteUseCase = <TInput, TOutput>(
  deps: WriteUseCaseDeps,
  spec: WriteSpec<TInput, TOutput>,
): UseCase<TInput, TOutput> => {
  const fallbackTargetKey = spec.fallbackTargetKey ?? defaultFallbackTargetKey;
  const { peers, targetKey: targetKeyOf } = peerHooksOf<TInput>(spec);

  return {
    verb: spec.verb,
    async execute(ctx, input): Promise<Result<TOutput, AppError>> {
      const resolvedTargets = await resolveTargets(ctx, peers(input));
      const targetKey =
        targetKeyOf(input) ??
        (resolvedTargets.ok
          ? fallbackTargetKey(resolvedTargets.value)
          : undefined);

      const record = (
        outcome: 'allow' | 'deny',
        extra: AuditExtra,
        overrideTargetKey?: string,
      ): Promise<Result<void, AppError>> => {
        // A per-target ACL deny records the FAILING target, not the default primary key.
        const auditTargetKey = overrideTargetKey ?? targetKey;
        return deps.auditLog.append(
          buildAuditRecord(deps.clock, ctx.endpoint.name, spec.verb, {
            outcome,
            ...(auditTargetKey !== undefined
              ? { targetChatId: auditTargetKey }
              : {}),
            ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
            ...(extra.idempotencyKey !== undefined
              ? { idempotencyKey: extra.idempotencyKey }
              : {}),
          }),
        );
      };

      if (!resolvedTargets.ok) {
        await record('deny', { reason: resolvedTargets.error.code });
        return err(resolvedTargets.error);
      }

      // 1. ACL — each addressed peer against its required verb; a deny audits the failing
      // target.
      const perTargetVerbs = spec.peerVerbs?.(input);
      const failure = firstAclFailure(deps.aclEvaluator, ctx, {
        verb: spec.verb,
        targets: resolvedTargets.value,
        ...(perTargetVerbs !== undefined ? { targetVerbs: perTargetVerbs } : {}),
      });
      if (failure !== undefined) {
        await record(
          'deny',
          { reason: failure.decision.reason },
          failure.target?.toKey(),
        );
        return err(aclDeniedError(failure.decision));
      }

      // 2. HITL before quota: a declined write never touches Telegram, so it must spend no
      // quota.
      if (ctx.endpoint.requiresConfirmation(spec.verb)) {
        const confirmation = await deps.confirmer.requestConfirmation({
          endpointName: ctx.endpoint.name,
          verb: spec.verb,
          description: spec.description,
          ...(targetKey !== undefined ? { targetChatId: targetKey } : {}),
        });
        if (!confirmation.ok) {
          await record('deny', { reason: 'confirmation_unavailable' });
          return err(confirmation.error);
        }
        if (!confirmation.value) {
          await record('deny', { reason: 'confirmation_declined' });
          return err(
            appError(
              AppErrorCode.ConfirmationRequired,
              'Human confirmation was declined',
            ),
          );
        }
      }

      // 3. Quota keyed per SESSION — one budget and breaker per shared account, not per
      // endpoint.
      const quota = await deps.rateLimiter.tryConsume({
        endpointName: ctx.endpoint.name,
        sessionRef: ctx.endpoint.sessionRef,
        bucket: spec.bucket,
      });
      if (!quota.ok) {
        await record('deny', { reason: quota.error.code });
        return err(quota.error);
      }

      // 4. Delegate to the scoped writer, then 5. audit the outcome.
      const result = await spec.run(ctx.client, input);
      if (result.ok) {
        const key = spec.auditKey?.(result.value);
        await record('allow', key !== undefined ? { idempotencyKey: key } : {});
      } else {
        await record('deny', { reason: result.error.code });
      }
      return result;
    },
  };
};
