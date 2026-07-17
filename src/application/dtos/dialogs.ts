/**
 * Dialog & chat-info read DTOs (in-scope only). Untrusted titles/about carried
 * as UntrustedText for structured emission.
 */
import type { UntrustedText } from '../../domain/index.js';

export type ChatKind = 'user' | 'bot' | 'group' | 'supergroup' | 'channel';

export interface DialogDto {
  readonly chatId: string;
  readonly title: UntrustedText;
  readonly kind: ChatKind;
  readonly unreadCount: number;
  readonly pinned: boolean;
  /** Forum supergroup — its "subchats" are topics; enumerate via list_topics. */
  readonly isForum: boolean;
}

export interface ChatInfoDto {
  readonly chatId: string;
  readonly title: UntrustedText;
  readonly kind: ChatKind;
  readonly about?: UntrustedText;
  readonly membersCount?: number;
  /** Broadcast channel — drives the scope-lint warn on write-verbs. */
  readonly isBroadcast: boolean;
  readonly isForum: boolean;
}

/**
 * One member of an in-scope group/channel (read verb, `list_participants`). The id
 * is a canonical-id STRING; the display name is attacker-controlled -> untrusted.
 * `username` is the syntactically-constrained public handle (no untrusted prose).
 */
export interface ParticipantDto {
  readonly id: string;
  readonly displayName: UntrustedText;
  readonly username?: string;
  readonly isBot: boolean;
}
