/**
 * `send_message` — write-tier `send` verb.
 *
 * Presentation only: declares the tool contract, maps args -> a `SendMessageCommand`, and
 * shapes the ack. Everything load-bearing (ACL, anti-ban quota, HITL, dedup, audit) lives in
 * the injected use-case; this handler never touches the gateway. The ack carries only safe
 * scalars — no untrusted Telegram strings.
 */
import type { z } from 'zod';
import { ok } from '../../../shared/index.js';
import type {
  SendMessageCommand,
  SendResultDto,
  UseCase,
} from '../../../application/index.js';
import type { ToolDefinition } from '../registry.js';
import {
  peerRefSchema,
  messageTextSchema,
  messageIdSchema,
  idempotencyKeySchema,
  topicIdSchema,
} from '../schemas/primitives.js';
import { sendAckOutputShape } from '../schemas/outputs.js';
import { defineTool } from './define-tool.js';

const sendMessageInputShape = {
  peer: peerRefSchema,
  text: messageTextSchema,
  replyToMessageId: messageIdSchema
    .optional()
    .describe('Optional id of a message to reply to (same chat).'),
  topicId: topicIdSchema
    .optional()
    .describe('Post into this forum topic of a forum supergroup (see list_topics).'),
  idempotencyKey: idempotencyKeySchema.optional(),
} satisfies z.ZodRawShape;

export const createSendMessageTool = (
  useCase: UseCase<SendMessageCommand, SendResultDto>,
): ToolDefinition<typeof sendMessageInputShape> =>
  defineTool({
    name: 'send_message',
    title: 'Send a text message',
    description:
      'Send a plain-text message to a single in-scope chat. The chat must be ' +
      'inside this endpoint’s allow-list; out-of-scope targets are rejected. ' +
      'For a forum supergroup, set topicId (from list_topics) to post into that ' +
      'topic. Subject to the per-endpoint anti-ban quota and, when enabled, human ' +
      'confirmation. An optional idempotency key gives BEST-EFFORT retry de-dup ' +
      '(in-memory, per-process; reset on restart/policy change and NOT covering a send ' +
      'Telegram accepted but reported as failed) — do not assume a retry is safe.',
    inputShape: sendMessageInputShape,
    outputShape: sendAckOutputShape,
    useCase,
    present: (sent) =>
      ok({
        structured: {
          chat_id: sent.chatId,
          message_id: sent.messageId,
          sent_at: sent.dateIso,
          idempotency_key: sent.idempotencyKey,
        },
      }),
  });
