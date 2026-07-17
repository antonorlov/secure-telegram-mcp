/**
 * Use-case ENGINE — the ONE home for the read/write orchestration every tool's
 * use-case shares. Two engine builders turn a small per-use-case SPEC into a
 * `UseCase<I, O>`; the shared resolve -> ACL -> (gate|HITL+quota) -> run -> audit
 * logic lives here once instead of across 14 subclasses.
 *
 * READ order (`makeReadUseCase`): resolve peers -> ACL (verb + per-target scope,
 * or a single no-target eval for scope-wide reads) -> optional post-ACL `gate`
 * (read-side quota for the search fan-out) -> scoped read. A denied read audits
 * DENY and fails closed BEFORE the gate, so a doomed read never draws quota; a
 * successful read is not audited (the log records writes + denials, not reads).
 *
 * WRITE order (`makeWriteUseCase`), strict so a doomed/unconfirmed request
 * consumes neither quota nor a human's attention: resolve -> ACL -> HITL confirm
 * (when the endpoint requires it; BEFORE quota because the RateLimiter has no
 * refund) -> anti-ban quota (keyed per session) -> scoped write -> audit ALLOW
 * (with idempotency key) / DENY(error). Every fail-closed branch appends a DENY
 * audit record.
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

// ---------------------------------------------------------------------------
// Injected collaborator bundles
// ---------------------------------------------------------------------------

/** Collaborators every read use-case needs (queries: ACL + audit only). */
export interface ReadUseCaseDeps {
  readonly aclEvaluator: DefaultAclEvaluator;
  readonly auditLog: AuditLog;
  readonly clock: Clock;
  /** Anti-ban limiter: only the search gate consumes read-side quota. */
  readonly rateLimiter: RateLimiter;
}

/** Collaborators every write use-case needs (ACL + quota + HITL + audit). */
export interface WriteUseCaseDeps extends ReadUseCaseDeps {
  readonly confirmer: Confirmer;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Resolve each `PeerRef` through the scoped client (fail-closed, in order). */
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

/** Structured detail for a DENY / ALLOW audit record (no untrusted prose). */
interface AuditExtra {
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

/** The dominant input shape: a command/query addressing exactly one peer. */
interface SinglePeerInput {
  readonly peer: PeerRef;
}

/**
 * A spec's peer hooks: which peers to resolve + scope-check and the primary
 * audit/HITL key. Both DEFAULT to the dominant single-peer shape —
 * `[input.peer]` / `primaryKeyOf(input.peer)` — and may be omitted ONLY when
 * `TInput` carries `peer: PeerRef`; every other input (scope-wide reads,
 * forward's two peers) must spell both out (compile-time constraint).
 */
type PeerHooks<TInput> = TInput extends SinglePeerInput
  ? {
      readonly peers?: (input: TInput) => readonly PeerRef[];
      readonly targetKey?: (input: TInput) => string | undefined;
    }
  : {
      readonly peers: (input: TInput) => readonly PeerRef[];
      readonly targetKey: (input: TInput) => string | undefined;
    };

/** Resolve a spec's peer hooks, applying the single-peer defaults. */
const peerHooksOf = <TInput>(
  spec: PeerHooks<TInput>,
): {
  readonly peers: (input: TInput) => readonly PeerRef[];
  readonly targetKey: (input: TInput) => string | undefined;
} => ({
  // The defaults are reachable only when TInput extends SinglePeerInput (the
  // hooks are required otherwise), so the assertions are sound; a mistake
  // still fails closed at resolvePeer.
  peers:
    spec.peers ??
    ((input): readonly PeerRef[] => [(input as TInput & SinglePeerInput).peer]),
  targetKey:
    spec.targetKey ??
    ((input): string | undefined =>
      primaryKeyOf((input as TInput & SinglePeerInput).peer)),
});

// ---------------------------------------------------------------------------
// Read engine
// ---------------------------------------------------------------------------

/**
 * A read use-case's unique content. Everything else (resolve/ACL/deny-audit) is
 * the shared engine. `gate` is the only hook: a read that AMPLIFIES into many
 * gateway calls (search fan-out) reserves read-side quota here, post-ACL, from
 * the shared deps bundle.
 */
export type ReadSpec<TInput, TOutput> = PeerHooks<TInput> & {
  /**
   * The single verb this read requires. Default `read`; a media-EGRESS read
   * (download_media) declares `read_media`, which the scoped data layer ALSO
   * re-checks per-chat, so the two gates agree on the verb.
   */
  readonly verb?: PermissionVerb;
  /** Delegate to the scoped reader once ACL (and any gate) has allowed. */
  readonly run: (
    reader: ScopedReader,
    input: TInput,
  ) => Promise<Result<TOutput, AppError>>;
  /** Optional post-ACL, pre-read gate (read-side quota). Default: free. */
  readonly gate?: (
    ctx: EndpointExecutionContext,
    input: TInput,
    deps: ReadUseCaseDeps,
  ) => Promise<Result<void, AppError>>;
  /**
   * Append an ALLOW audit record on SUCCESS (the read log otherwise records only
   * denials). Used by media EGRESS to attempt an ALLOW audit record after each
   * successful download. Sink failures are reported out of band by the adapter.
   */
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

      // Post-ACL gate (read-side quota) — runs AFTER ACL so a denied request
      // never draws quota; a refusal is a security-relevant DENY audit record.
      if (spec.gate !== undefined) {
        const gated = await spec.gate(ctx, input, deps);
        if (!gated.ok) {
          await auditDeny(ctx, targetKey, gated.error.code);
          return err(gated.error);
        }
      }

      const result = await spec.run(ctx.client, input);
      // Attempt an ALLOW record for successful media egress; the read log
      // otherwise records only denials. A sink failure is loud but does not turn
      // an already-completed download into a false failure response.
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

// ---------------------------------------------------------------------------
// Write engine
// ---------------------------------------------------------------------------

/** A write use-case's unique content; the shared engine hosts the ordering. */
export type WriteSpec<TInput, TOutput> = PeerHooks<TInput> & {
  /** The single verb this command requires. */
  readonly verb: PermissionVerb;
  /** The anti-ban bucket this command draws from. */
  readonly bucket: QuotaBucket;
  /** Operator-facing, structured HITL description (no untrusted prose). */
  readonly description: string;
  /**
   * Optional PER-TARGET verbs, aligned 1:1 with `peers`, for a command that reads
   * one peer and writes another: `forward` requires `read` on the SOURCE and
   * `forward` on the DESTINATION, not the same verb on both. Omit for the common
   * single-verb path (every target checked against `verb`). The quota bucket, HITL,
   * and audit-record verb stay `verb` (the operation's identity).
   */
  readonly peerVerbs?: (input: TInput) => readonly PermissionVerb[];
  /** Delegate to the scoped writer after all gates pass. */
  readonly run: (
    writer: ScopedWriter,
    input: TInput,
  ) => Promise<Result<TOutput, AppError>>;
  /**
   * Audit/HITL key from the RESOLVED targets when the input carried no `id`
   * peer. Default: the single resolution (single-target commands). Forward
   * overrides this to pick its DESTINATION so the approver sees where it goes.
   */
  readonly fallbackTargetKey?: (
    targets: readonly ChatId[],
  ) => string | undefined;
  /** Idempotency key to record from the result (sends echo theirs). */
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
        // A per-target ACL deny records the FAILING target (e.g. forward's source),
        // not the default primary/destination key.
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

      // 1. ACL — each addressed peer against ITS required verb (default `spec.verb`;
      //    a spec may declare per-target verbs, e.g. forward = read(src)+forward(dst)).
      //    A deny audits the FAILING target so the record pinpoints where it stopped.
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

      // 2. HITL confirmation, BEFORE quota (a declined write never touches
      //    Telegram, so it must spend no anti-ban quota — the port has no refund).
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

      // 3. Anti-ban quota (keyed per SESSION — one budget + breaker per shared
      //    account, not per endpoint name).
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
