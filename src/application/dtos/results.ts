/**
 * Write-side result DTOs — acknowledgements returned by command use-cases (a
 * minimal ack, not a full read model).
 */

export interface SendResultDto {
  readonly chatId: string;
  readonly messageId: number;
  readonly dateIso: string;
  /** The random_id used for idempotent dedup; echoed for traceability. */
  readonly idempotencyKey: string;
}

export interface EditResultDto {
  readonly chatId: string;
  readonly messageId: number;
  readonly editedDateIso: string;
}

export interface DeleteResultDto {
  readonly chatId: string;
  readonly deletedMessageIds: readonly number[];
  /** Whether the delete revoked for everyone (default false). */
  readonly revoked: boolean;
}

export interface DraftResultDto {
  readonly chatId: string;
  readonly saved: boolean;
}

export interface MarkReadResultDto {
  readonly chatId: string;
  readonly maxReadMessageId: number;
}

export interface ForwardResultDto {
  readonly fromChatId: string;
  readonly toChatId: string;
  readonly forwardedMessageIds: readonly number[];
}

/** Minimal ack for a reaction write (verb `react`). Safe scalars only. */
export interface ReactionResultDto {
  readonly chatId: string;
  readonly messageId: number;
  /** The single emoji that was set (echoed for traceability). */
  readonly emoji: string;
}

/**
 * Opaque media handle for the two-phase send_media flow. The handle is bound to
 * session + scope + a TTL; the raw path is NEVER re-supplied by the model — it
 * passes back only this handle.
 */
export interface MediaHandleDto {
  readonly handle: string;
  readonly expiresAtIso: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
}
