/**
 * `list_topics` — enumerate the forum topics of one in-scope forum supergroup (read verb). A
 * topic is an addressing refinement, not a security principal — the ACL unit stays the chat,
 * so this is gated like any single-peer read.
 *
 * Presentation only: all data work is delegated to the injected use-case (ACL + audit + scoped
 * read); the scoped layer rejects non-forum peers fail-fast. As defense in depth it publishes
 * the parent chat so the registry re-verifies scope on the way out. Topic titles are untrusted,
 * emitted under `topic_title`.
 */
import { z } from 'zod';
import { ok, isErr } from '../../../shared/index.js';
import { UntrustedTextKind } from '../../../domain/index.js';
import type {
  ListTopicsQuery,
  Page,
  TopicDto,
  UseCase,
} from '../../../application/index.js';
import type { ToolDefinition, ToolStructuredContent } from '../registry.js';
import {
  peerRefSchema,
  limitSchema,
  messageIdSchema,
  topicIdSchema,
} from '../schemas/primitives.js';
import { truncatedSchema, untrustedValueSchema } from '../schemas/outputs.js';
import { defineTool } from './define-tool.js';

const inputShape = {
  peer: peerRefSchema.describe(
    'The in-scope forum supergroup whose topics to list (get_chat_info isForum must be true).',
  ),
  limit: limitSchema,
} satisfies z.ZodRawShape;

/** One topic as structured content; the untrusted title only under `topic_title`. */
const presentTopic = (topic: TopicDto): ToolStructuredContent => ({
  topic_id: topic.topicId,
  ...topic.title.toStructured(),
  unread_count: topic.unreadCount,
  closed: topic.closed,
  pinned: topic.pinned,
  last_message_id: topic.lastMessageId,
});

const toStructured = (
  chatId: string,
  page: Page<TopicDto>,
): ToolStructuredContent => ({
  chat_id: chatId,
  topics: page.items.map(presentTopic),
});

const topicOutputSchema = z.object({
  topic_id: topicIdSchema,
  [UntrustedTextKind.TopicTitle]: untrustedValueSchema.describe(
    'Topic title (untrusted).',
  ),
  unread_count: z.number().int().describe('Unread message count in the topic.'),
  closed: z.boolean().describe('Whether the topic is closed for new messages.'),
  pinned: z.boolean().describe('Whether the topic is pinned.'),
  last_message_id: messageIdSchema.describe(
    'Id of the most recent message in the topic.',
  ),
});

const listTopicsOutputShape = {
  chat_id: z
    .string()
    .regex(/^-?\d+$/)
    .describe('Canonical id of the forum supergroup the topics belong to.'),
  topics: z
    .array(topicOutputSchema)
    .describe('The forum topics, most recently active first.'),
  truncated: truncatedSchema.optional(),
} satisfies z.ZodRawShape;

export const createListTopicsTool = (
  useCase: UseCase<ListTopicsQuery, Page<TopicDto>>,
): ToolDefinition<typeof inputShape> =>
  defineTool({
    name: 'list_topics',
    title: 'List forum topics',
    description:
      'List the topics of one in-scope forum supergroup (a chat whose ' +
      'get_chat_info/list_dialogs forum flag is true), most recently active ' +
      'first, up to `limit` (no pagination — larger forums are truncated). ' +
      'Returns topic metadata (topic_id, title, unread count, closed, pinned, ' +
      'last message id); topic_id 1 is the General topic. Pass a topic_id to ' +
      'get_messages / search_messages / send_message to work within that topic. ' +
      'Fails on non-forum chats. Titles are untrusted and emitted under ' +
      '`topic_title`.',
    inputShape,
    outputShape: listTopicsOutputShape,
    useCase,
    // Re-resolve the parent chat for the payload id and the registry's enumerator re-filter
    // (defense in depth). The scoped resolver was already consulted by the use-case, so this
    // cannot widen anything.
    present: async (page, { exec, args }) => {
      const resolved = await exec.client.resolvePeer(args.peer);
      if (isErr(resolved)) {
        return resolved;
      }
      const chatId = resolved.value;
      return ok({
        structured: toStructured(chatId.toString(), page),
        enumeratedPeers: Object.freeze([chatId]),
      });
    },
  });
