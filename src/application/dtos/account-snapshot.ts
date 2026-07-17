import type { ChatKind } from './dialogs.js';

/** A sanitized account dialog shown only to the authenticated operator. */
export interface AccountChatDto {
  readonly id: string;
  readonly title: string;
  readonly kind: ChatKind;
  readonly username?: string;
  readonly isContact?: boolean;
  readonly isMuted?: boolean;
  readonly isUnread?: boolean;
  readonly isArchived?: boolean;
  readonly hasUnreadMention?: boolean;
}

/** Telegram folder metadata needed by the scope picker. */
export interface AccountFolderFlagsDto {
  readonly contacts: boolean;
  readonly nonContacts: boolean;
  readonly groups: boolean;
  readonly broadcasts: boolean;
  readonly bots: boolean;
  readonly excludeMuted: boolean;
  readonly excludeRead: boolean;
  readonly excludeArchived: boolean;
}

export interface AccountFolderDto {
  readonly id: number;
  readonly title: string;
  readonly chatIds: readonly string[];
  readonly excludeChatIds?: readonly string[];
  readonly flags?: AccountFolderFlagsDto;
}

/** One consistent operator view of the account's dialogs and folders. */
export interface AccountSnapshotDto {
  readonly chats: readonly AccountChatDto[];
  readonly folders: readonly AccountFolderDto[];
}
