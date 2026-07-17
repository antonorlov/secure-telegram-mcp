/** Operator-only account enumeration over a daemon-owned Telegram connection. */
import { Api, type TelegramClient } from 'telegram';
import type { UnicodeSanitizer } from '../sanitize/unicode-sanitizer.js';

import type {
  AccountChatDto,
  AccountFolderDto,
  AccountSnapshotDto,
  AppError,
} from '../../application/index.js';
import { UntrustedTextKind } from '../../domain/index.js';
import { err, ok, type Result } from '../../shared/index.js';
import { mapGramjsError } from './gramjs-errors.js';
import {
  canonicalIdOf,
  chatKindOf,
  isContactOf,
  isResolvedEntity,
  titleOf,
  usernameOf,
} from './gramjs-mappers.js';
import {
  dialogFilterChatKeys,
  dialogFilterExcludeKeys,
  dialogFilterFlags,
} from './telegram-peer-id.js';

const ARCHIVE_FOLDER_ID = 1;

interface RawDialogState {
  readonly unreadCount?: number;
  readonly unreadMentionsCount?: number;
  readonly unreadMark?: boolean;
  readonly folderId?: number;
  readonly notifySettings?: { readonly muteUntil?: number };
}

const dialogState = (
  dialog: unknown,
  nowSec: number,
): Pick<
  AccountChatDto,
  'isMuted' | 'isUnread' | 'isArchived' | 'hasUnreadMention'
> => {
  const raw = (dialog as { readonly dialog?: RawDialogState }).dialog;
  return {
    isMuted:
      typeof raw?.notifySettings?.muteUntil === 'number' &&
      raw.notifySettings.muteUntil > nowSec,
    isUnread: (raw?.unreadCount ?? 0) > 0 || raw?.unreadMark === true,
    isArchived: raw?.folderId === ARCHIVE_FOLDER_ID,
    hasUnreadMention: (raw?.unreadMentionsCount ?? 0) > 0,
  };
};

const listChats = async (
  client: TelegramClient,
  sanitizer: UnicodeSanitizer,
): Promise<readonly AccountChatDto[]> => {
  const dialogs = await client.getDialogs({});
  const chats: AccountChatDto[] = [];
  const seen = new Set<string>();
  const nowSec = Math.floor(Date.now() / 1000);
  for (const dialog of dialogs) {
    try {
      const entity = dialog.entity;
      if (!isResolvedEntity(entity)) continue;
      const id = canonicalIdOf(entity).toString();
      if (seen.has(id)) continue;
      seen.add(id);
      const username = usernameOf(entity);
      chats.push({
        id,
        title: titleOf(entity, sanitizer).sanitizedValue,
        kind: chatKindOf(entity),
        ...(username !== undefined ? { username } : {}),
        isContact: isContactOf(entity),
        ...dialogState(dialog, nowSec),
      });
    } catch {
      // One malformed dialog must not hide the rest of the account snapshot.
      continue;
    }
  }
  return chats;
};

const listFolders = async (
  client: TelegramClient,
  sanitizer: UnicodeSanitizer,
): Promise<readonly AccountFolderDto[]> => {
  const result = await client.invoke(new Api.messages.GetDialogFilters());
  const folders: AccountFolderDto[] = [];
  for (const filter of result.filters) {
    if (filter.className === 'DialogFilterDefault') continue;
    const flags = dialogFilterFlags(filter);
    const excludeChatIds = dialogFilterExcludeKeys(filter);
    folders.push({
      id: filter.id,
      title: sanitizer
        .sanitize(UntrustedTextKind.ChatTitle, filter.title.text.trim())
        .sanitizedValue,
      chatIds: dialogFilterChatKeys(filter),
      ...(flags !== undefined ? { flags } : {}),
      ...(excludeChatIds.length > 0 ? { excludeChatIds } : {}),
    });
  }
  return folders;
};

export const readAccountSnapshot = async (
  client: TelegramClient,
  sanitizer: UnicodeSanitizer,
): Promise<Result<AccountSnapshotDto, AppError>> => {
  try {
    const [chats, folders] = await Promise.all([
      listChats(client, sanitizer),
      listFolders(client, sanitizer),
    ]);
    return ok({ chats, folders });
  } catch (error) {
    return err(mapGramjsError(error, 'operator'));
  }
};
