/**
 * `prepare_media` + `send_media` — the two-phase media flow for the write-tier `send` verb,
 * kept in one module (one capability, two tools).
 *
 *   phase 1 — `prepare_media({ localPath })` -> opaque `MediaHandleDto`. The only point a
 *       filesystem path is accepted; the use-case/gateway confine it, size-cap it, and mint an
 *       opaque handle bound to session + scope + TTL.
 *   phase 2 — `send_media({ peer, handle, caption? })` -> send ACK. Consumes only the handle
 *       (a raw path is not even in the schema — structurally un-smuggleable). Expired/forged/
 *       mismatched handles are rejected below.
 *
 * Presentation only: input shapes here are syntactic; path confinement, TTL/scope binding,
 * ACL, HITL, quota, and audit attempts live in the injected use-cases. Both acks carry only safe scalars
 * minted by our layers.
 */
import { z } from 'zod';
import { ok } from '../../../shared/index.js';
import type {
  PrepareMediaCommand,
  SendMediaCommand,
  MediaHandleDto,
  SendResultDto,
  UseCase,
} from '../../../application/index.js';
import type { ToolDefinition } from '../registry.js';
import {
  peerRefSchema,
  captionSchema,
  idempotencyKeySchema,
  topicIdSchema,
} from '../schemas/primitives.js';
import { isoInstantSchema, sendAckOutputShape } from '../schemas/outputs.js';
import { defineTool } from './define-tool.js';

// --- Locally-owned bounded primitives (this feature owns path/handle; validation here is
// syntactic only — semantic confinement is the data layer's). --

/** Conservative upper bound on an accepted local path (PATH_MAX-ish). */
export const MAX_LOCAL_PATH_LENGTH = 4096;
/** Upper bound on an opaque, gateway-minted media handle token. */
export const MAX_MEDIA_HANDLE_LENGTH = 1024;

/** Rejects any ASCII/Unicode control character (incl. NUL) — never valid in a path. */
const CONTROL_CHAR = /\p{Cc}/u;

const localPathSchema = z
  .string()
  .min(1, 'localPath must not be empty')
  .max(MAX_LOCAL_PATH_LENGTH)
  .refine((p) => !CONTROL_CHAR.test(p), 'localPath must not contain control characters')
  .describe(
    'Local filesystem path to the media file to stage for upload. Accepted ' +
      'ONLY here (phase 1); the server confines it to the allowed upload area, ' +
      'size-caps it, and returns an opaque, time-limited handle. You never pass ' +
      'a raw path to send_media.',
  );

const mediaHandleSchema = z
  .string()
  .min(1, 'handle must not be empty')
  .max(MAX_MEDIA_HANDLE_LENGTH)
  .describe(
    'Opaque handle returned by prepare_media. Pass it back verbatim. It is ' +
      'bound to this session, this endpoint scope, and a short TTL; expired or ' +
      'mismatched handles are rejected. Never pass a filesystem path here.',
  );

// --- Phase 1 — prepare_media ---

const prepareMediaInputShape = {
  localPath: localPathSchema,
} satisfies z.ZodRawShape;

const prepareMediaOutputShape = {
  handle: z
    .string()
    .describe(
      'Opaque, time-limited media handle bound to this session and scope; ' +
        'pass it to send_media verbatim.',
    ),
  expires_at: isoInstantSchema.describe('Instant the handle expires (TTL).'),
  size_bytes: z.number().describe('Staged file size in bytes.'),
  mime_type: z
    .string()
    .describe('Locally sniffed MIME type (trusted; not Telegram-originated).'),
} satisfies z.ZodRawShape;

export const createPrepareMediaTool = (
  useCase: UseCase<PrepareMediaCommand, MediaHandleDto>,
): ToolDefinition<typeof prepareMediaInputShape> =>
  defineTool({
    name: 'prepare_media',
    title: 'Prepare media for sending',
    description:
      'Phase 1 of the two-phase media send. Stage a local file and receive an ' +
      'opaque, time-limited handle bound to this session and endpoint scope. The ' +
      'server confines the path to the permitted upload area and caps its size. ' +
      'Pass the returned handle to send_media; you never re-supply the raw path.',
    inputShape: prepareMediaInputShape,
    outputShape: prepareMediaOutputShape,
    useCase,
    present: (handle) =>
      ok({
        structured: {
          handle: handle.handle,
          expires_at: handle.expiresAtIso,
          size_bytes: handle.sizeBytes,
          mime_type: handle.mimeType,
        },
      }),
  });

// --- Phase 2 — send_media (no path field: a raw path is structurally un-sendable) ---

const sendMediaInputShape = {
  peer: peerRefSchema,
  handle: mediaHandleSchema,
  caption: captionSchema.optional(),
  topicId: topicIdSchema
    .optional()
    .describe('Post into this forum topic of a forum supergroup (see list_topics).'),
  idempotencyKey: idempotencyKeySchema.optional(),
} satisfies z.ZodRawShape;

export const createSendMediaTool = (
  useCase: UseCase<SendMediaCommand, SendResultDto>,
): ToolDefinition<typeof sendMediaInputShape> =>
  defineTool({
    name: 'send_media',
    title: 'Send prepared media',
    description:
      'Phase 2 of the two-phase media send. Send media to a single in-scope chat ' +
      'using ONLY an opaque handle from prepare_media (no filesystem path is ' +
      'accepted). The target must be inside this endpoint scope; out-of-scope ' +
      'peers, and expired or mismatched handles, are rejected. Subject to the ' +
      'per-endpoint anti-ban quota and, when enabled, human confirmation. An ' +
      'optional idempotency key gives BEST-EFFORT retry de-dup (in-memory, ' +
      'per-process; reset on restart/policy change and NOT covering a send Telegram ' +
      'accepted but reported as failed) — do not assume a retry is safe.',
    inputShape: sendMediaInputShape,
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
