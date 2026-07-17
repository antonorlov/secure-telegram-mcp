/**
 * `search_messages` — in-scope message search (read verb).
 *
 * Presentation only: it owns the tool's API contract and the DTO -> structured mapping.
 * Sequential, call-bounded fan-out across in-scope peers, per-peer read-gating and the
 * composite cursor are the scoped client's job, reached through the injected use-case. There
 * is no global search. As a multi-peer enumerator it publishes the peers the result touches so
 * the registry re-verifies each is in scope. Untrusted strings surface only as named envelopes
 * via the shared `presentMessage`.
 */
import { z } from 'zod';
import { ok } from '../../../shared/index.js';
import {
  appError,
  AppErrorCode,
  type MessageDto,
  type Page,
  type SearchMessagesQuery,
  type UseCase,
} from '../../../application/index.js';
import {
  peerRefSchema,
  limitSchema,
  cursorSchema,
  topicIdSchema,
} from '../schemas/primitives.js';
import {
  messageOutputSchema,
  presentMessage,
  nextCursorSchema,
  truncatedSchema,
} from '../schemas/outputs.js';
import type { ToolDefinition, ToolStructuredContent } from '../registry.js';
import { collectEnumeratedPeers, defineTool } from './define-tool.js';

/** Upper bound on a search query (bounded input discipline). */
const MAX_SEARCH_QUERY = 256;

const searchQuerySchema = z
  .string()
  .trim()
  .min(1, 'search query must not be empty')
  .max(MAX_SEARCH_QUERY)
  .describe(
    `Full-text query, 1..${String(MAX_SEARCH_QUERY)} chars; matched ONLY within in-scope peers (never a global search).`,
  );

const searchMessagesInputShape = {
  query: searchQuerySchema,
  peer: peerRefSchema
    .optional()
    .describe(
      'Optional single in-scope peer to search; omit to fan out across the whole scope.',
    ),
  limit: limitSchema,
  cursor: cursorSchema
    .optional()
    .describe('Opaque composite cursor from a prior search page; pass verbatim.'),
  topicId: topicIdSchema
    .optional()
    .describe(
      'Restrict the search to one forum topic; requires `peer` (a topic exists inside a single forum supergroup).',
    ),
} satisfies z.ZodRawShape;

const searchMessagesOutputShape = {
  messages: z
    .array(messageOutputSchema)
    .describe('The matching in-scope messages for this page.'),
  count: z
    .number()
    .int()
    .nonnegative()
    .describe('Number of messages in this page.'),
  next_cursor: nextCursorSchema
    .optional()
    .describe('Opaque composite cursor for the next page; pass back verbatim.'),
  truncated: truncatedSchema.optional(),
} satisfies z.ZodRawShape;

const presentPage = (page: Page<MessageDto>): ToolStructuredContent => ({
  messages: page.items.map(presentMessage),
  count: page.items.length,
  ...(page.nextCursor !== undefined ? { next_cursor: page.nextCursor } : {}),
});

/**
 * Build the `search_messages` tool. Listed for every endpoint (static menu); its
 * `requiredVerb = read` is enforced per target chat at execution, and the scoped reader
 * returns only in-scope, read-permitted hits.
 */
export const createSearchMessagesTool = (
  useCase: UseCase<SearchMessagesQuery, Page<MessageDto>>,
): ToolDefinition<typeof searchMessagesInputShape> =>
  defineTool({
    name: 'search_messages',
    title: 'Search messages (in-scope)',
    description:
      'Search messages within this endpoint’s in-scope peers only. ' +
      'Omit `peer` to fan out across the whole scope (each peer read-gated), ' +
      'or set it to search one in-scope peer. Add `topicId` (with `peer`) to ' +
      'search a single forum topic. Never performs a global search. ' +
      'Telegram-originated strings are returned as structured JSON under named ' +
      'keys (untrusted_text, sender_display_name), never as prose.',
    inputShape: searchMessagesInputShape,
    outputShape: searchMessagesOutputShape,
    useCase,
    // Cross-field rule the SDK's raw-shape validation cannot express: a topic
    // filter is meaningless without the single chat it lives in.
    validate: (args) =>
      args.topicId !== undefined && args.peer === undefined
        ? appError(
            AppErrorCode.Validation,
            'topicId requires peer: a forum topic is scoped to a single chat',
          )
        : undefined,
    present: (page) => {
      const peers = collectEnumeratedPeers(page.items, (m) => m.chatId);
      return peers.ok
        ? ok({ structured: presentPage(page), enumeratedPeers: peers.value })
        : peers;
    },
  });
