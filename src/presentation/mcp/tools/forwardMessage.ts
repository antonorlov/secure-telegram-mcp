/**
 * `forward_message` — write-tier `forward` verb. Same-group only: both peers must live in the
 * one bound scope, so a cross-group forward is structurally impossible.
 *
 * Presentation only: maps args -> a `ForwardMessageCommand` and shapes the ack. The injected
 * use-case scope-checks both peers, then HITL -> quota (`forwards` bucket) -> scoped writer ->
 * audit attempt. The batch is bounded by the shared `messageIdsSchema` (SDK -32602 before the
 * handler). The ack carries only safe scalars.
 */
import { z } from 'zod';
import { ok } from '../../../shared/index.js';
import type {
  ForwardMessageCommand,
  ForwardResultDto,
  UseCase,
} from '../../../application/index.js';
import type { ToolDefinition } from '../registry.js';
import {
  peerRefSchema,
  messageIdSchema,
  messageIdsSchema,
} from '../schemas/primitives.js';
import { canonicalIdSchema } from '../schemas/outputs.js';
import { defineTool } from './define-tool.js';

const forwardMessageInputShape = {
  fromPeer: peerRefSchema.describe(
    'Source chat to forward FROM. Must be inside this endpoint’s allow-list ' +
      '(same virtual group as the destination); read access is required.',
  ),
  toPeer: peerRefSchema.describe(
    'Destination chat to forward TO. Must be inside this endpoint’s allow-list ' +
      '(same virtual group as the source); send access is required.',
  ),
  messageIds: messageIdsSchema,
} satisfies z.ZodRawShape;

const forwardMessageOutputShape = {
  from_chat_id: canonicalIdSchema.describe('Source chat forwarded from.'),
  to_chat_id: canonicalIdSchema.describe('Destination chat forwarded to.'),
  forwarded_message_ids: z
    .array(messageIdSchema)
    .describe('Ids of the newly created messages in the destination chat.'),
} satisfies z.ZodRawShape;

export const createForwardMessageTool = (
  useCase: UseCase<ForwardMessageCommand, ForwardResultDto>,
): ToolDefinition<typeof forwardMessageInputShape> =>
  defineTool({
    name: 'forward_message',
    title: 'Forward message(s)',
    description:
      'Forward one or more messages from one in-scope chat to another. BOTH the ' +
      'source and destination chats must be inside this endpoint’s allow-list ' +
      '(the same virtual group); cross-group forwarding is not possible. Subject ' +
      'to the per-endpoint anti-ban quota and, when enabled, human confirmation. ' +
      'The batch of message ids is capped per request.',
    inputShape: forwardMessageInputShape,
    outputShape: forwardMessageOutputShape,
    useCase,
    present: (forwarded) =>
      ok({
        structured: {
          from_chat_id: forwarded.fromChatId,
          to_chat_id: forwarded.toChatId,
          forwarded_message_ids: forwarded.forwardedMessageIds,
        },
      }),
  });
