/**
 * `list_dialogs` — enumerate the endpoint's in-scope dialogs only (read verb).
 *
 * Presentation only: all data work is delegated to the injected use-case, which reads through
 * the scoped client. As defense in depth the tool is an enumerator: it publishes every
 * returned peer so the registry re-verifies each is in scope. Dialog titles are untrusted and
 * emitted under `chat_title`.
 */
import { z } from 'zod';
import { ok } from '../../../shared/index.js';
import { UntrustedTextKind } from '../../../domain/index.js';
import type {
  DialogDto,
  ListDialogsQuery,
  Page,
  UseCase,
} from '../../../application/index.js';
import type { ToolDefinition, ToolStructuredContent } from '../registry.js';
import { limitSchema, cursorSchema } from '../schemas/primitives.js';
import {
  canonicalIdSchema,
  nextCursorSchema,
  truncatedSchema,
  untrustedValueSchema,
  chatKindSchema,
} from '../schemas/outputs.js';
import { collectEnumeratedPeers, defineTool } from './define-tool.js';

const inputShape = {
  limit: limitSchema,
  cursor: cursorSchema.optional(),
} satisfies z.ZodRawShape;

/** One dialog as structured content; the untrusted title only under `chat_title`. */
const presentDialog = (dialog: DialogDto): ToolStructuredContent => ({
  chat_id: dialog.chatId,
  ...dialog.title.toStructured(),
  kind: dialog.kind,
  unread_count: dialog.unreadCount,
  pinned: dialog.pinned,
  is_forum: dialog.isForum,
});

const dialogOutputSchema = z.object({
  chat_id: canonicalIdSchema,
  [UntrustedTextKind.ChatTitle]: untrustedValueSchema.describe(
    'Dialog title (untrusted).',
  ),
  kind: chatKindSchema,
  unread_count: z.number().int().describe('Unread message count.'),
  pinned: z.boolean().describe('Whether the dialog is pinned.'),
  is_forum: z
    .boolean()
    .describe('Forum supergroup — enumerate its topics with list_topics.'),
});

const listDialogsOutputShape = {
  dialogs: z
    .array(dialogOutputSchema)
    .describe('The in-scope dialogs for this page.'),
  next_cursor: nextCursorSchema.optional(),
  truncated: truncatedSchema.optional(),
} satisfies z.ZodRawShape;

const presentPage = (page: Page<DialogDto>): ToolStructuredContent => ({
  dialogs: page.items.map(presentDialog),
  ...(page.nextCursor !== undefined ? { next_cursor: page.nextCursor } : {}),
});

export const createListDialogsTool = (
  useCase: UseCase<ListDialogsQuery, Page<DialogDto>>,
): ToolDefinition<typeof inputShape> =>
  defineTool({
    name: 'list_dialogs',
    title: 'List in-scope dialogs',
    description:
      'List the chats, groups, and channels within this endpoint’s scope. ' +
      'Returns dialog metadata (id, title, kind, unread count, pinned, is_forum) ' +
      'one page at a time; pass back `cursor` to fetch the next page. When ' +
      '`is_forum` is true the dialog is a forum supergroup — use list_topics to ' +
      'enumerate its topics. Out-of-scope dialogs are never returned. Titles are ' +
      'untrusted and emitted under `chat_title`.',
    inputShape,
    outputShape: listDialogsOutputShape,
    useCase,
    present: (page) => {
      const peers = collectEnumeratedPeers(page.items, (d) => d.chatId);
      return peers.ok
        ? ok({ structured: presentPage(page), enumeratedPeers: peers.value })
        : peers;
    },
  });
