/**
 * Write-tier use-case SPECS (commands; return a minimal ack) — the single
 * catalogue-side list of what each write does. Every entry is a small spec
 * handed to the shared write engine ({@link makeWriteUseCase}), which hosts the
 * strict-order resolve -> ACL -> HITL -> quota -> write -> audit pipeline once.
 * Peer hooks default to the dominant single-peer shape (`[input.peer]` /
 * `primaryKeyOf`).
 *
 * PrepareMedia is the one exception ({@link createPrepareMediaUseCase}): it
 * registers a LOCAL file with no peer and no Telegram side effect, so it skips
 * HITL and quota — but it attempts an audit record because it probes the host
 * filesystem inside the media root. Its verb-gate is peer-less, asking "can this endpoint Send to
 * ANY reachable in-scope chat?" — the OR-gate over the whole scope (group grant ∪
 * any per-chat Send override, minus denied) — so a read-only-group endpoint with a
 * per-chat Send override can prepare media for that chat. `send_media` still
 * re-gates its specific target per-chat.
 */
import { err, type Result } from '../../shared/index.js';
import { PermissionVerb } from '../../domain/index.js';
import type { AppError } from '../errors.js';
import type {
  SendResultDto,
  EditResultDto,
  DeleteResultDto,
  DraftResultDto,
  MarkReadResultDto,
  ForwardResultDto,
  ReactionResultDto,
  MediaHandleDto,
} from '../dtos/results.js';
import type {
  SendMessageCommand,
  EditMessageCommand,
  DeleteMessageCommand,
  SaveDraftCommand,
  MarkReadCommand,
  ForwardMessageCommand,
  SendReactionCommand,
  PrepareMediaCommand,
  SendMediaCommand,
} from '../dtos/commands.js';
import type { UseCase } from './use-case.js';
import type { EndpointExecutionContext } from './context.js';
import {
  aclDeniedError,
  buildAuditRecord,
  permitsVerbForAnyReachableTarget,
  primaryKeyOf,
} from './use-case-support.js';
import type { ReadUseCaseDeps, WriteSpec } from './use-case-engine.js';

export { makeWriteUseCase } from './use-case-engine.js';
export type { WriteUseCaseDeps } from './use-case-engine.js';

/**
 * Typed constructor: binds a spec literal to its contract (in a form the
 * explicit-return-type lint recognizes — `satisfies` is invisible to it) and
 * FREEZES it. The engine reads authorization metadata (verb, bucket, hooks)
 * from the spec reference at execute time, so an unfrozen entry could drift
 * from the verb the registry snapshot exposes.
 */
const writeSpec = <TInput, TOutput>(
  spec: WriteSpec<TInput, TOutput>,
): WriteSpec<TInput, TOutput> => {
  Object.freeze(spec);
  return spec;
};

export const WRITE_SPECS = Object.freeze({
  sendMessage: writeSpec<SendMessageCommand, SendResultDto>({
    verb: PermissionVerb.Send,
    bucket: 'messages',
    description: 'Send a text message',
    run: (writer, input) => writer.sendMessage(input),
    auditKey: (output) => output.idempotencyKey,
  }),

  editMessage: writeSpec<EditMessageCommand, EditResultDto>({
    verb: PermissionVerb.Send,
    bucket: 'messages',
    description: 'Edit a message',
    run: (writer, input) => writer.editMessage(input),
  }),

  deleteMessage: writeSpec<DeleteMessageCommand, DeleteResultDto>({
    verb: PermissionVerb.Delete,
    bucket: 'messages',
    description: 'Delete message(s)',
    run: (writer, input) => writer.deleteMessage(input),
  }),

  saveDraft: writeSpec<SaveDraftCommand, DraftResultDto>({
    verb: PermissionVerb.Draft,
    bucket: 'messages',
    description: 'Save a draft',
    run: (writer, input) => writer.saveDraft(input),
  }),

  markRead: writeSpec<MarkReadCommand, MarkReadResultDto>({
    verb: PermissionVerb.MarkRead,
    bucket: 'messages',
    description: 'Mark messages read',
    run: (writer, input) => writer.markRead(input),
  }),

  /**
   * Forward resolves TWO peers ([from, to]) and applies a TWO-SIDED verb rule: it
   * requires `read` on the SOURCE and `forward` on the DESTINATION (not the same verb
   * on both) — reading a chat you may read and forwarding INTO a chat you may forward
   * to. The bucket/HITL/audit verb stays `forward` (the operation's identity); the
   * audit/HITL key is the resolved DESTINATION (index 1) so the approver sees where it
   * goes, and a per-target ACL deny records the failing side.
   */
  forwardMessage: writeSpec<ForwardMessageCommand, ForwardResultDto>({
    verb: PermissionVerb.Forward,
    bucket: 'forwards',
    description: 'Forward message(s)',
    peers: (input) => [input.fromPeer, input.toPeer],
    peerVerbs: () => [PermissionVerb.Read, PermissionVerb.Forward],
    targetKey: (input) => primaryKeyOf(input.toPeer),
    fallbackTargetKey: (targets) => targets[1]?.toKey(),
    run: (writer, input) => writer.forwardMessage(input),
  }),

  /**
   * Reaction — a lightweight WRITE (verb `react`) drawing the `messages` bucket,
   * with the standard HITL + quota + audit ordering. A single in-scope target.
   */
  sendReaction: writeSpec<SendReactionCommand, ReactionResultDto>({
    verb: PermissionVerb.React,
    bucket: 'messages',
    description: 'React to a message',
    run: (writer, input) => writer.sendReaction(input),
  }),

  sendMedia: writeSpec<SendMediaCommand, SendResultDto>({
    verb: PermissionVerb.Send,
    bucket: 'messages',
    description: 'Send prepared media',
    run: (writer, input) => writer.sendMedia(input),
    auditKey: (output) => output.idempotencyKey,
  }),
});

/**
 * PrepareMedia (phase 1) — verb-gated registration of a LOCAL file. Needs no
 * limiter/confirmer, only the ACL + audit pair. Every attempt submits an audit
 * record (allow/deny); the raw path is NEVER included (it would leak host layout).
 */
export const createPrepareMediaUseCase = (
  deps: ReadUseCaseDeps,
): UseCase<PrepareMediaCommand, MediaHandleDto> => {
  const verb = PermissionVerb.Send;
  const record = (
    ctx: EndpointExecutionContext,
    outcome: 'allow' | 'deny',
    reason: string | undefined,
  ): Promise<Result<void, AppError>> =>
    deps.auditLog.append(
      buildAuditRecord(deps.clock, ctx.endpoint.name, verb, {
        outcome,
        ...(reason !== undefined ? { reason } : {}),
      }),
    );

  return {
    verb,
    async execute(ctx, input): Promise<Result<MediaHandleDto, AppError>> {
      const decision = permitsVerbForAnyReachableTarget(
        deps.aclEvaluator,
        ctx,
        verb,
      );
      if (!decision.allowed) {
        await record(ctx, 'deny', decision.reason);
        return err(aclDeniedError(decision));
      }
      const result = await ctx.client.prepareMedia(input);
      // Peer-less op: outcome + reason only (never the raw path).
      await record(
        ctx,
        result.ok ? 'allow' : 'deny',
        result.ok ? undefined : result.error.code,
      );
      return result;
    },
  };
};
