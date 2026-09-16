// Untrusted titles and about-text ride as `UntrustedText` for structured emission.
import type { UntrustedText } from '../../domain/index.js';

export type ChatKind = 'user' | 'bot' | 'group' | 'supergroup' | 'channel';

export interface DialogDto {
  readonly chatId: string;
  readonly title: UntrustedText;
  readonly kind: ChatKind;
  readonly unreadCount: number;
  readonly pinned: boolean;
  // Subchats are topics — enumerate them with list_topics.
  readonly isForum: boolean;
}

export interface ChatInfoDto {
  readonly chatId: string;
  readonly title: UntrustedText;
  readonly kind: ChatKind;
  readonly about?: UntrustedText;
  readonly membersCount?: number;
  // Drives the scope-lint warning on write verbs.
  readonly isBroadcast: boolean;
  readonly isForum: boolean;
}

// The display name is attacker-controlled; `username` is the syntactically-constrained public
// handle.
export interface ParticipantDto {
  readonly id: string;
  readonly displayName: UntrustedText;
  readonly username?: string;
  readonly isBot: boolean;
}
