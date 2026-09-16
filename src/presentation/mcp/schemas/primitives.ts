/**
 * Shared, bounded Zod input primitives composed into each tool's `inputShape`, so validation
 * and error text are identical everywhere.
 * A chat reference is the discriminated union `{ kind, value }`, and only syntactic
 * normalization happens here — strip a leading '@', parse the id form, validate the username
 * grammar — emitting an unresolved domain `PeerRef`. Resolution belongs to endpoint binding,
 * where a temporary gateway-owned resolver expands only the declared scope.
 * Zod is pinned to the exact version the MCP SDK is built against, so a `z.ZodRawShape`
 * produced here is structurally accepted by `registerTool`. Use field-level `.describe()`: the
 * SDK propagates per-field, not top-level, descriptions.
 */
import { z } from 'zod';
import { isErr } from '../../../shared/index.js';
import { PeerRefFactory, ChatId, type PeerRef } from '../../../domain/index.js';

// Telegram per-chat message ids are 32-bit ints.
export const MAX_MESSAGE_ID = 2_147_483_647;
// Batch cap for multi-message ops (delete / forward) — anti-abuse bound.
export const MAX_MESSAGE_BATCH = 100;
// Telegram text message hard limit.
export const MAX_MESSAGE_TEXT = 4096;
// Telegram media caption hard limit.
export const MAX_CAPTION = 1024;
// Default page size when a caller omits `limit`.
export const DEFAULT_PAGE_LIMIT = 20;
// Upper bound a single read may return (output-size discipline).
export const MAX_PAGE_LIMIT = 100;
// Opaque cursors are black boxes; bound their length defensively.
export const MAX_CURSOR_LENGTH = 4096;
// Idempotency-key length cap.
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
// The `.max()` runs before `.regex()` and `BigInt()`, so an oversized model-supplied payload is
// rejected cheaply. Canonical ids, including the -100 channel prefix, are at most ~20 digits.
export const MAX_PEER_ID_LENGTH = 32;

const peerIdVariant = z.object({
  kind: z.literal('id'),
  value: z
    .string()
    .trim()
    .max(MAX_PEER_ID_LENGTH, 'peer id too long')
    .regex(/^-?\d+$/, 'peer id must be a decimal integer string'),
});

const peerUsernameVariant = z.object({
  kind: z.literal('username'),
  value: z.string().trim().min(1, 'username must not be empty'),
});

const peerMeVariant = z.object({ kind: z.literal('me') });

// Emits an unresolved domain `PeerRef`: an id parses locally with no network, a username stays
// a username variant by invariant, and `me` is the self variant.
export const peerRefSchema = z
  .discriminatedUnion('kind', [
    peerIdVariant,
    peerUsernameVariant,
    peerMeVariant,
  ])
  .describe(
    "Chat reference: { kind:'id', value:'<decimal id>' } | { kind:'username', value:'@name' } | { kind:'me' }.",
  )
  .transform((input, ctx): PeerRef => {
    switch (input.kind) {
      case 'id': {
        const parsed = ChatId.fromString(input.value);
        if (isErr(parsed)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: parsed.error.message,
          });
          return z.NEVER;
        }
        return PeerRefFactory.fromId(parsed.value);
      }
      case 'username': {
        const parsed = PeerRefFactory.fromUsername(input.value);
        if (isErr(parsed)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: parsed.error.message,
          });
          return z.NEVER;
        }
        return parsed.value;
      }
      case 'me':
        return PeerRefFactory.me();
    }
  });

export const messageIdSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_MESSAGE_ID)
  .describe('A positive per-chat message id.');

export const messageIdsSchema = z
  .array(messageIdSchema)
  .min(1)
  .max(MAX_MESSAGE_BATCH)
  .describe(`Between 1 and ${String(MAX_MESSAGE_BATCH)} message ids.`);

// A forum-topic id IS a per-chat message id — the topic root's service message — so it shares
// the messageId bounds; only the meaning differs.
export const topicIdSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_MESSAGE_ID)
  .describe(
    'Forum topic id (the topic root message id; 1 = the General topic). ' +
      'Obtain from list_topics or from a message’s topicId. Only valid in forum supergroups.',
  );

// Clamps into `[1, MAX_PAGE_LIMIT]` instead of rejecting, so a slightly-wrong model request
// stays usable while the hard upper bound still holds.
export const limitSchema = z
  .number()
  .int()
  .optional()
  .transform((n): number =>
    Math.min(Math.max(n ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT),
  )
  .describe(
    `Page size, clamped to [1, ${String(MAX_PAGE_LIMIT)}] (default ${String(DEFAULT_PAGE_LIMIT)}).`,
  );

export const cursorSchema = z
  .string()
  .min(1)
  .max(MAX_CURSOR_LENGTH)
  .describe('Opaque pagination cursor returned by a prior page; pass verbatim.');

export const messageTextSchema = z
  .string()
  .min(1, 'message text must not be empty')
  .max(MAX_MESSAGE_TEXT)
  .describe(`Message body, 1..${String(MAX_MESSAGE_TEXT)} characters.`);

export const captionSchema = z
  .string()
  .max(MAX_CAPTION)
  .describe(`Optional media caption, up to ${String(MAX_CAPTION)} characters.`);

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(MAX_IDEMPOTENCY_KEY_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, 'idempotency key must be url-safe')
  .describe(
    'Optional caller-supplied idempotency key (url-safe). Reusing it on a retry ' +
      'gives BEST-EFFORT, in-memory de-dup only (not guaranteed across restarts, ' +
      'policy changes, or a send Telegram accepted but reported as failed).',
  );

// A single grapheme can be several UTF-16 code units (flags, skin-tone and ZWJ sequences), so
// the cap is generous; the grapheme check below is what enforces "exactly one".
export const MAX_EMOJI_LENGTH = 32;

const graphemeCount = (value: string): number => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;
  for (const _segment of segmenter.segment(value)) {
    count += 1;
  }
  return count;
};

// Rejecting multi-grapheme input at the schema layer keeps arbitrary strings out of the
// reaction payload — the gateway only ever forwards a single standard emoticon.
export const emojiSchema = z
  .string()
  .trim()
  .min(1, 'emoji must not be empty')
  .max(MAX_EMOJI_LENGTH, 'emoji is too long')
  .refine((value) => graphemeCount(value) === 1, {
    message: 'must be a single emoji',
  })
  .describe('A single emoji to react with (one grapheme cluster).');
