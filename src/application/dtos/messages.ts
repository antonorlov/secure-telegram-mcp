/**
 * Read-side message & media-metadata DTOs — WIRE/CONTRACT shapes, distinct from
 * domain models and GramJS types. Every untrusted, Telegram-originated string is
 * carried as `UntrustedText` (emitted as structured JSON under a named key,
 * never interpolated into prose). IDs are canonical-id STRINGS (decimal bigint)
 * to stay JSON-safe.
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

/** Metadata ONLY — no bytes; media byte egress is deferred. */
export interface MediaInfoDto {
  readonly kind: MediaKind;
  /** mime_type is attacker-controlled (the sender sets it) -> untrusted. */
  readonly mimeType?: UntrustedText;
  readonly sizeBytes?: number;
  /** File name is attacker-controlled -> untrusted. */
  readonly fileName?: UntrustedText;
  readonly durationSeconds?: number;
  readonly width?: number;
  readonly height?: number;
}

/**
 * One reaction bucket on a message: the emoji and how many accounts chose it.
 * The emoji is sender/Telegram-originated but already sanitized to a plain string
 * (a single short grapheme), so it rides as a scalar, not an UntrustedText envelope.
 */
export interface MessageReactionDto {
  readonly emoji: string;
  readonly count: number;
}

export interface MessageDto {
  readonly messageId: number;
  readonly chatId: string;
  readonly senderId?: string;
  /** Resolved from the SCOPED entity cache only, sanitized as untrusted. */
  readonly senderDisplayName?: UntrustedText;
  readonly dateIso: string;
  readonly editedDateIso?: string;
  readonly text?: UntrustedText;
  readonly replyToMessageId?: number;
  /** Forum topic the message belongs to (1 = General); absent in non-forums. */
  readonly topicId?: number;
  readonly forwarded: boolean;
  readonly media?: MediaInfoDto;
  /** Standard-emoji reaction tallies (sanitized emoji, capped list); absent when none. */
  readonly reactions?: readonly MessageReactionDto[];
}

/**
 * The result of a media EGRESS download (verb `read_media`). The bytes are written
 * to a SERVER-GENERATED path inside the confined media root's `downloads/` subdir —
 * the caller never supplies a path, and no bytes cross the port. `fileName` is the
 * attacker-controlled ORIGINAL name (untrusted, for display only), distinct from the
 * safe on-disk basename in `filePath`.
 */
export interface MediaFileDto {
  readonly filePath: string;
  /** Sanitized MIME string (sender-controlled but cleaned to a plain token). */
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly fileName?: UntrustedText;
}
