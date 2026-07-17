/**
 * `delete_message` — write-tier `delete` verb. Deletes one or more in-scope messages in a
 * single chat.
 *
 * Presentation only: maps args -> a `DeleteMessageCommand` and shapes the ack. ACL -> HITL ->
 * quota -> scoped writer -> audit attempt all live in the injected use-case. `revoke` defaults to false
 * (least-privilege); the batch is bounded by the shared `messageIdsSchema` (SDK -32602 before
 * the handler).
 */
import { z } from 'zod';
import { ok } from '../../../shared/index.js';
import type {
  DeleteMessageCommand,
  DeleteResultDto,
  UseCase,
} from '../../../application/index.js';
import {
  peerRefSchema,
  messageIdSchema,
  messageIdsSchema,
} from '../schemas/primitives.js';
import { canonicalIdSchema } from '../schemas/outputs.js';
import type { ToolDefinition } from '../registry.js';
import { defineTool } from './define-tool.js';

/**
 * `revoke` is delete-specific (not a shared primitive). Defaults to false (least-privilege):
 * omit to delete only for yourself; pass `true` for everyone.
 */
const revokeSchema = z
  .boolean()
  .optional()
  .default(false)
  .describe(
    'When true, delete the message(s) for everyone (revoke). Default false ' +
      'deletes only for yourself.',
  );

const deleteMessageInputShape = {
  peer: peerRefSchema,
  messageIds: messageIdsSchema,
  revoke: revokeSchema,
} satisfies z.ZodRawShape;

const deleteMessageOutputShape = {
  chat_id: canonicalIdSchema.describe('Chat the messages were deleted from.'),
  deleted_message_ids: z
    .array(messageIdSchema)
    .describe('The message ids that were deleted (echo of the request batch).'),
  revoked: z
    .boolean()
    .describe('Whether the delete revoked for everyone (false = self only).'),
} satisfies z.ZodRawShape;

export const createDeleteMessageTool = (
  useCase: UseCase<DeleteMessageCommand, DeleteResultDto>,
): ToolDefinition<typeof deleteMessageInputShape> =>
  defineTool({
    name: 'delete_message',
    title: 'Delete message(s)',
    description:
      'Delete one or more messages in a single in-scope chat. Defaults to ' +
      'deleting only for yourself; set revoke=true to remove for everyone. ' +
      'Out-of-scope chats are rejected; the batch is capped per request.',
    inputShape: deleteMessageInputShape,
    outputShape: deleteMessageOutputShape,
    useCase,
    present: (dto) =>
      ok({
        structured: {
          chat_id: dto.chatId,
          deleted_message_ids: dto.deletedMessageIds,
          revoked: dto.revoked,
        },
      }),
  });
