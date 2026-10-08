import { z } from 'zod';
import { ok } from '../../../shared/index.js';
import {
  type SendMessageCommand,
  type SendResultDto,
  type UseCase,
  type EditMessageCommand,
  type EditResultDto,
  type DeleteMessageCommand,
  type DeleteResultDto,
  type SaveDraftCommand,
  type DraftResultDto,
  appError,
  AppErrorCode,
  type MarkReadCommand,
  type MarkReadResultDto,
  type ForwardMessageCommand,
  type ForwardResultDto,
  type SendReactionCommand,
  type ReactionResultDto,
} from '../../../application/index.js';
import type { ToolDefinition } from '../registry.js';
import {
  peerRefSchema,
  messageTextSchema,
  messageIdSchema,
  idempotencyKeySchema,
  topicIdSchema,
  messageIdsSchema,
  emojiSchema,
} from '../schemas/primitives.js';
import {
  sendAckOutputShape,
  canonicalIdSchema,
  isoInstantSchema,
  reactionAckOutputShape,
} from '../schemas/outputs.js';
import { defineTool } from './define-tool.js';

// `send_message` — write-tier `send`. Presentation only: everything load-bearing (ACL, anti-ban
// quota, HITL, dedup, audit) lives in the injected use-case.
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

// `edit_message` — write-tier `send`: replaces the text of one of the userbot's own messages,
// addressed by `{ peer, messageId }`.
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

// `delete_message` — write-tier `delete`, for one or more in-scope messages in a single chat.

// `revoke` is delete-specific and defaults to false (least privilege): omit to delete only for
// yourself, pass `true` to delete for everyone.
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

// `save_draft` — write-tier `draft`, deliberately distinct from `send` so a draft-only endpoint
// can store drafts without ever sending.
const saveDraftInputShape = {
  peer: peerRefSchema,
  text: messageTextSchema,
  replyToMessageId: messageIdSchema
    .optional()
    .describe('Optional id of a message this draft replies to (same chat).'),
  topicId: topicIdSchema
    .optional()
    .describe('Address the draft to this forum topic of a forum supergroup.'),
} satisfies z.ZodRawShape;

const saveDraftOutputShape = {
  chat_id: canonicalIdSchema.describe('Chat the draft was stored on.'),
  saved: z.boolean().describe('Whether the draft was stored.'),
} satisfies z.ZodRawShape;

export const createSaveDraftTool = (
  useCase: UseCase<SaveDraftCommand, DraftResultDto>,
): ToolDefinition<typeof saveDraftInputShape> =>
  defineTool({
    name: 'save_draft',
    title: 'Save a draft',
    description:
      'Store a plain-text draft on a single in-scope chat WITHOUT sending it. ' +
      'The chat must be inside this endpoint’s allow-list; out-of-scope targets ' +
      'are rejected. Requires the `draft` permission (distinct from `send`), is ' +
      'subject to the per-endpoint anti-ban quota and, when enabled, human ' +
      'confirmation. Saving an empty draft is not supported here; clearing a ' +
      'draft is out of scope for v1.',
    inputShape: saveDraftInputShape,
    outputShape: saveDraftOutputShape,
    useCase,
    present: (draft) =>
      ok({ structured: { chat_id: draft.chatId, saved: draft.saved } }),
  });

// `mark_read` — a write-tier verb of its own, because read receipts are observable by other
// participants.

// Optional high-water mark; reuses the shared bound. Omit to mark the whole dialog.
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

/**
 * `forward_message` — write-tier `forward` verb. Same-group only: both peers must live in the
 * one bound scope, so a cross-group forward is structurally impossible.
 *
 * Presentation only: maps args -> a `ForwardMessageCommand` and shapes the ack. The injected
 * use-case scope-checks both peers, then HITL -> quota (`forwards` bucket) -> scoped writer ->
 * audit attempt. The batch is bounded by the shared `messageIdsSchema` (SDK -32602 before the
 * handler). The ack carries only safe scalars.
 */
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

/**
 * `send_reaction` — write-tier `react` verb (a lightweight write).
 *
 * Presentation only: declares the contract, maps args -> a `SendReactionCommand`, and
 * shapes the ack. The ACL gate, anti-ban quota, HITL confirmation, and audit all live in
 * the injected use-case; this handler never touches the gateway. The emoji is validated as
 * a single grapheme at the schema layer; the ack carries only safe scalars.
 */
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
