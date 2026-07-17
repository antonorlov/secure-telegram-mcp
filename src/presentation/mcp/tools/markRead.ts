/**
 * `mark_read` — write-tier `mark_read` verb. Emits read receipts other participants can
 * observe, hence its own least-privilege verb.
 *
 * Presentation only: maps args -> a `MarkReadCommand` and shapes the ack. ACL -> HITL -> quota
 * -> scoped writer -> audit live in the injected use-case. The ack carries only safe scalars.
 */
import { z } from 'zod';
import {
  appError,
  AppErrorCode,
  type MarkReadCommand,
  type MarkReadResultDto,
  type UseCase,
} from '../../../application/index.js';
import { ok } from '../../../shared/index.js';
import {
  peerRefSchema,
  messageIdSchema,
  topicIdSchema,
} from '../schemas/primitives.js';
import { canonicalIdSchema } from '../schemas/outputs.js';
import type { ToolDefinition } from '../registry.js';
import { defineTool } from './define-tool.js';

/** Optional high-water mark; reuses the shared bound. Omit to mark the whole dialog. */
const maxMessageIdSchema = messageIdSchema
  .optional()
  .describe(
    'Mark read up to and including this message id; omit to mark the entire ' +
      'dialog read.',
  );

const markReadInputShape = {
  peer: peerRefSchema,
  maxMessageId: maxMessageIdSchema,
  topicId: topicIdSchema
    .optional()
    .describe(
      'Mark one forum topic read instead of the whole chat; requires maxMessageId ' +
        '(Telegram has no whole-topic form).',
    ),
} satisfies z.ZodRawShape;

const markReadOutputShape = {
  chat_id: canonicalIdSchema.describe('Chat that was marked read.'),
  max_read_message_id: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'High-water-mark message id marked read (0 when the whole dialog was marked).',
    ),
} satisfies z.ZodRawShape;

export const createMarkReadTool = (
  useCase: UseCase<MarkReadCommand, MarkReadResultDto>,
): ToolDefinition<typeof markReadInputShape> =>
  defineTool({
    name: 'mark_read',
    title: 'Mark chat read',
    description:
      'Mark an in-scope chat read, emitting read receipts. Provide maxMessageId ' +
      'to mark read up to a specific message, or omit it to mark the whole ' +
      'dialog read. For a forum supergroup, add topicId (with maxMessageId) to ' +
      'mark a single topic read. Out-of-scope chats are rejected.',
    inputShape: markReadInputShape,
    outputShape: markReadOutputShape,
    useCase,
    // Cross-field rule the raw shape cannot express: a topic read-marker needs
    // its explicit high-water mark.
    validate: (args) =>
      args.topicId !== undefined && args.maxMessageId === undefined
        ? appError(
            AppErrorCode.Validation,
            'marking a forum topic read requires maxMessageId',
          )
        : undefined,
    present: (dto) =>
      ok({
        structured: {
          chat_id: dto.chatId,
          max_read_message_id: dto.maxReadMessageId,
        },
      }),
  });
