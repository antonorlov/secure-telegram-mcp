/**
 * Wire shapes, distinct from domain models and GramJS types. Untrusted Telegram strings ride as
 * `UntrustedText` — emitted as structured JSON, never interpolated into prose — and ids are
 * canonical decimal strings to stay JSON-safe.
 */
import type { UntrustedText } from '../../domain/index.js';

export type MediaKind =
  | 'photo'
  | 'video'
  | 'document'
  | 'audio'
  | 'voice'
  | 'sticker'
  | 'other';

// Metadata only — no bytes.
export interface MediaInfoDto {
  readonly kind: MediaKind;
  readonly mimeType?: UntrustedText;
  readonly sizeBytes?: number;
  readonly fileName?: UntrustedText;
  readonly durationSeconds?: number;
  readonly width?: number;
  readonly height?: number;
}

// The emoji is already sanitized to a plain grapheme, so it rides as a scalar rather than an
// `UntrustedText` envelope.
export interface MessageReactionDto {
  readonly emoji: string;
  readonly count: number;
}

export interface MessageDto {
  readonly messageId: number;
  readonly chatId: string;
  readonly senderId?: string;
  // Resolved from the scoped entity cache only.
  readonly senderDisplayName?: UntrustedText;
  readonly dateIso: string;
  readonly editedDateIso?: string;
  readonly text?: UntrustedText;
  readonly replyToMessageId?: number;
  // 1 = General; absent in non-forums.
  readonly topicId?: number;
  readonly forwarded: boolean;
  readonly media?: MediaInfoDto;
  readonly reactions?: readonly MessageReactionDto[];
}

/**
 * Bytes land on a server-generated path inside the confined media root — the caller never
 * supplies one. `fileName` is the attacker-controlled original name, for display only, distinct
 * from the safe basename in `filePath`.
 */
export interface MediaFileDto {
  readonly filePath: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly fileName?: UntrustedText;
}
