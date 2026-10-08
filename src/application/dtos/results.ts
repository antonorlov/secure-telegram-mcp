
export interface SendResultDto {
  readonly chatId: string;
  readonly messageId: number;
  readonly dateIso: string;
  // The random_id used for idempotent dedup.
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

export interface ReactionResultDto {
  readonly chatId: string;
  readonly messageId: number;
  readonly emoji: string;
}

// Bound to session, scope and a TTL; the model passes back only this handle, never the raw
// path.
export interface MediaHandleDto {
  readonly handle: string;
  readonly expiresAtIso: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
}
