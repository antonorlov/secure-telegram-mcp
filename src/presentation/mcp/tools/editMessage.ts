/**
 * `edit_message` — write-tier `send` verb. Replaces the text of one of the userbot's own
 * messages, addressed by `{ peer, messageId }`.
 *
 * Presentation only: maps args -> an `EditMessageCommand` and shapes the ack. ACL / HITL /
 * quota / audit attempt and the "own messages only" data-layer rule live in the injected use-case; this
 * handler never touches the gateway. The ack carries only safe scalars.
 */
import type { z } from 'zod';
import { ok } from '../../../shared/index.js';
import type {
  EditMessageCommand,
  EditResultDto,
  UseCase,
} from '../../../application/index.js';
import type { ToolDefinition } from '../registry.js';
import {
  peerRefSchema,
  messageIdSchema,
  messageTextSchema,
} from '../schemas/primitives.js';
import { canonicalIdSchema, isoInstantSchema } from '../schemas/outputs.js';
import { defineTool } from './define-tool.js';

const editMessageInputShape = {
  peer: peerRefSchema,
  messageId: messageIdSchema,
  text: messageTextSchema,
} satisfies z.ZodRawShape;

const editMessageOutputShape = {
  chatId: canonicalIdSchema.describe('Chat containing the edited message.'),
  messageId: messageIdSchema.describe('Id of the edited message.'),
  editedDateIso: isoInstantSchema.describe('Server-acknowledged edit instant.'),
} satisfies z.ZodRawShape;

export const createEditMessageTool = (
  useCase: UseCase<EditMessageCommand, EditResultDto>,
): ToolDefinition<typeof editMessageInputShape> =>
  defineTool({
    name: 'edit_message',
    title: 'Edit message',
    description:
      'Edit the text of one of your own messages in a chat within this endpoint ' +
      'scope. Addressed by { peer, messageId }; the new text replaces the old. ' +
      'Out-of-scope peers and messages you did not send are rejected.',
    inputShape: editMessageInputShape,
    outputShape: editMessageOutputShape,
    useCase,
    present: (dto) =>
      ok({
        structured: {
          chatId: dto.chatId,
          messageId: dto.messageId,
          editedDateIso: dto.editedDateIso,
        },
      }),
  });
