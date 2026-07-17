/**
 * `save_draft` — write-tier `draft` verb (distinct from `send` so a draft-only endpoint can
 * store drafts without ever sending). Stores, does not send.
 *
 * Presentation only: maps args -> a `SaveDraftCommand` and shapes the ack. ACL / quota / HITL /
 * audit live in the injected use-case. The ack carries only safe scalars.
 */
import { z } from 'zod';
import { ok } from '../../../shared/index.js';
import type {
  SaveDraftCommand,
  DraftResultDto,
  UseCase,
} from '../../../application/index.js';
import type { ToolDefinition } from '../registry.js';
import {
  peerRefSchema,
  messageTextSchema,
  messageIdSchema,
  topicIdSchema,
} from '../schemas/primitives.js';
import { canonicalIdSchema } from '../schemas/outputs.js';
import { defineTool } from './define-tool.js';

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
