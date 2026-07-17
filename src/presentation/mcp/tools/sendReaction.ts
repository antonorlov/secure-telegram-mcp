/**
 * `send_reaction` — write-tier `react` verb (a lightweight write).
 *
 * Presentation only: declares the contract, maps args -> a `SendReactionCommand`, and
 * shapes the ack. The ACL gate, anti-ban quota, HITL confirmation, and audit all live in
 * the injected use-case; this handler never touches the gateway. The emoji is validated as
 * a single grapheme at the schema layer; the ack carries only safe scalars.
 */
import type { z } from 'zod';
import { ok } from '../../../shared/index.js';
import type {
  SendReactionCommand,
  ReactionResultDto,
  UseCase,
} from '../../../application/index.js';
import type { ToolDefinition } from '../registry.js';
import {
  peerRefSchema,
  messageIdSchema,
  emojiSchema,
} from '../schemas/primitives.js';
import { reactionAckOutputShape } from '../schemas/outputs.js';
import { defineTool } from './define-tool.js';

const sendReactionInputShape = {
  peer: peerRefSchema,
  messageId: messageIdSchema,
  emoji: emojiSchema,
} satisfies z.ZodRawShape;

export const createSendReactionTool = (
  useCase: UseCase<SendReactionCommand, ReactionResultDto>,
): ToolDefinition<typeof sendReactionInputShape> =>
  defineTool({
    name: 'send_reaction',
    title: 'React to a message',
    description:
      'Set a single-emoji reaction on one in-scope message. The chat must be inside ' +
      'this endpoint’s allow-list; out-of-scope targets are rejected. Subject to the ' +
      'per-endpoint anti-ban quota and, when enabled, human confirmation. The emoji must ' +
      'be a single emoji; an emoji Telegram does not allow for the chat is rejected.',
    inputShape: sendReactionInputShape,
    outputShape: reactionAckOutputShape,
    useCase,
    present: (dto) =>
      ok({
        structured: {
          chat_id: dto.chatId,
          message_id: dto.messageId,
          emoji: dto.emoji,
        },
      }),
  });
