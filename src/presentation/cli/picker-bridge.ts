/**
 * Picker bridge — the pure adapter from the daemon account snapshot +
 * folder membership) to the picker's framework-free model: the flattened tree `Row[]` the
 * PickerScreen renders and the `PickerEnumeration` the config<->picker mapper projects
 * through. Framework-free (no Ink/React/node:*): string/data in, picker model out.
 *
 * Folder -> chat hierarchy. When folder membership is supplied, each folder is a
 * collapsed-by-default tri-state parent row, followed by its member chats nested at depth 1.
 * A chat that lives in N folders appears under each of them, but selection stays one
 * id-keyed entry — the same `chatKey` under distinct `RowId`s — so marking it once marks it
 * everywhere and its `folderTitles` drive the "(also in: …)" note. Chats in no folder (and
 * the synthetic self row) sit flat at depth 0.
 */
import { ChatId, PeerRefFactory, type PeerRef } from '../../domain/index.js';
import { isErr } from '../../shared/index.js';
import type {
  AccountChatDto,
  AccountFolderDto,
  AccountFolderFlagsDto,
} from '../../application/index.js';
import type {
  ChatKey,
  ChatRow,
  PickerChatKind,
  Row,
} from './picker/index.js';
import type {
  PickerChatSource,
  PickerEnumeration,
  PickerFolderSource,
} from './picker/index.js';

/** The synthetic self chat ('me' / Saved Messages), always offered at the top. */
const SELF_KEY: ChatKey = 'me';

/** Map the coarse setup `ChatKind` onto the picker's narrower kind vocabulary. */
const toPickerKind = (kind: AccountChatDto['kind']): PickerChatKind => {
  switch (kind) {
    case 'channel':
      return 'channel';
    case 'group':
    case 'supergroup':
      return 'group';
    case 'user':
    case 'bot':
      return 'user';
  }
};

/**
 * Canonical config ref for an enumerated chat: its numeric peer id as a domain
 * `PeerRef`. `undefined` drops a malformed live id (cannot round-trip through
 * config) — unreachable for a real enumeration, which emits canonical decimals.
 */
const chatRef = (chat: AccountChatDto): PeerRef | undefined => {
  const id = ChatId.fromString(chat.id);
  return isErr(id) ? undefined : PeerRefFactory.fromId(id.value);
};

/**
 * Does a chat match a folder's rule flags? Faithful to the official clients (TDLib
 * `need_dialog` / Desktop `ChatFilter::contains` / Web `isChatInFolder`), evaluated only for
 * chats not explicitly included/excluded (those are handled by the caller). Order:
 * status-excludes (archived / read / muted-without-mention) then the OR-ed type flags.
 */
export const chatMatchesFolderFlags = (
  chat: AccountChatDto,
  flags: AccountFolderFlagsDto,
): boolean => {
  if (flags.excludeArchived && chat.isArchived === true) return false;
  if (flags.excludeRead && chat.isUnread !== true) return false;
  if (
    flags.excludeMuted &&
    chat.isMuted === true &&
    chat.hasUnreadMention !== true
  ) {
    return false;
  }
  switch (chat.kind) {
    case 'user':
      return chat.isContact === true ? flags.contacts : flags.nonContacts;
    case 'bot':
      return flags.bots;
    case 'group':
    case 'supergroup':
      return flags.groups;
    case 'channel':
      return flags.broadcasts;
  }
};

export interface PickerTree {
  readonly rows: readonly Row[];
  readonly enumeration: PickerEnumeration;
}

/** The per-chat facts the tree/enumeration are projected from, keyed by ChatKey. */
interface ChatInfo {
  readonly title: string;
  readonly kind: PickerChatKind;
  readonly username?: string;
  readonly ref: PeerRef;
}

/**
 * Build the folder->chat picker tree + enumeration from the enumerated dialogs and
 * (optionally) their folder membership. The self ('me') chat is prepended so the operator
 * can scope their own Saved Messages; it carries the `{ kind: 'me' }` ref so the projection
 * round-trips it as `me`. With no folders supplied every chat is flat at depth 0.
 */
export const buildPickerTree = (
  chats: readonly AccountChatDto[],
  folders: readonly AccountFolderDto[] = [],
): PickerTree => {
  // Per-chat facts keyed for O(1) membership lookup; the self row is synthetic.
  const chatByKey = new Map<ChatKey, ChatInfo>();
  chatByKey.set(SELF_KEY, {
    title: 'me (Saved Messages)',
    kind: 'self',
    ref: PeerRefFactory.me(),
  });
  for (const chat of chats) {
    const ref = chatRef(chat);
    if (ref === undefined) continue; // malformed live id — drop, same as a stale ref
    chatByKey.set(chat.id, {
      title: chat.title,
      kind: toPickerKind(chat.kind),
      ...(chat.username !== undefined ? { username: chat.username } : {}),
      ref,
    });
  }

  // Telegram's native dialog order (getDialogs = pinned, then last activity) is the
  // incoming `chats` order; stamp each chat's rank so the display sort can use it as
  // the last-activity tiebreak. `me` leads (-1).
  const rankByKey = new Map<ChatKey, number>();
  rankByKey.set(SELF_KEY, -1);
  chats.forEach((chat, i) => {
    if (!rankByKey.has(chat.id)) rankByKey.set(chat.id, i);
  });

  // The folder titles each ENUMERATED chat appears under (drives "(also in: …)").
  const folderTitlesByKey = new Map<ChatKey, string[]>();
  for (const folder of folders) {
    for (const key of folder.chatIds) {
      if (!chatByKey.has(key)) continue; // not enumerated → cannot be shown/marked
      const list = folderTitlesByKey.get(key) ?? [];
      if (!list.includes(folder.title)) list.push(folder.title);
      folderTitlesByKey.set(key, list);
    }
  }

  const rows: Row[] = [];
  const chatSources: PickerChatSource[] = [];
  const folderSources: PickerFolderSource[] = [];
  const emittedSourceKeys = new Set<ChatKey>();

  /** One id-keyed enumeration source per real chat (deduped across folders). */
  const emitSource = (key: ChatKey, info: ChatInfo): void => {
    if (emittedSourceKeys.has(key)) return;
    emittedSourceKeys.add(key);
    chatSources.push({
      chatKey: key,
      ref: info.ref,
      title: info.title,
      ...(info.username !== undefined ? { username: info.username } : {}),
    });
  };

  /** A chat leaf row for `key` at `depth`; skips keys with no enumerated chat. */
  const emitChatRow = (rowId: string, key: ChatKey, depth: number): void => {
    const info = chatByKey.get(key);
    if (info === undefined) return;
    rows.push({
      kind: 'chat',
      id: rowId,
      depth,
      chatKey: key,
      title: info.title,
      chatKind: info.kind,
      ...(info.username !== undefined ? { username: info.username } : {}),
      folderTitles: folderTitlesByKey.get(key) ?? [],
      activityRank: rankByKey.get(key) ?? Number.MAX_SAFE_INTEGER,
    } satisfies ChatRow);
    emitSource(key, info);
  };

  // 1. Self ('me') at the top — always offered, flat at depth 0.
  emitChatRow(`chat:${SELF_KEY}`, SELF_KEY, 0);

  // 2. Folders as tri-state parents, each followed by its member chats (depth 1).
  //    A chat under N folders yields N rows (distinct RowId, one shared chatKey).
  const inAnyFolder = new Set<ChatKey>();
  for (const folder of folders) {
    const childChatKeys: ChatKey[] = [];
    // EXPLICIT members (pinned ∪ included) are the ONLY ones the runtime folder
    // resolver tracks, so only these commit as part of a `folders[]` unit ref;
    // rule-matched members snapshot as individual chats (the resolver ignores
    // flag membership — a unit ref over them would resolve to zero peers).
    const explicitChatKeys: ChatKey[] = [];
    const excluded = new Set<ChatKey>(folder.excludeChatIds ?? []);
    const addKey = (key: ChatKey, explicit: boolean): void => {
      if (!chatByKey.has(key)) return;
      if (!childChatKeys.includes(key)) {
        childChatKeys.push(key);
        inAnyFolder.add(key);
      }
      if (explicit && !explicitChatKeys.includes(key)) explicitChatKeys.push(key);
    };
    // 1. Always-included peers (pinned ∪ included) bypass the rule — EXPLICIT.
    for (const key of folder.chatIds) addKey(key, true);
    // 2. Rule-based members: every enumerated chat the folder's flags match, minus the
    //    "never" set — exactly what the Telegram apps show, but NOT explicit.
    if (folder.flags !== undefined) {
      const flags = folder.flags;
      for (const chat of chats) {
        if (excluded.has(chat.id)) continue;
        if (chatMatchesFolderFlags(chat, flags)) addKey(chat.id, false);
      }
    }
    rows.push({
      kind: 'folder',
      id: `folder:${String(folder.id)}`,
      depth: 0,
      title: folder.title,
      childChatKeys,
      explicitChatKeys,
      folderKey: String(folder.id),
    });
    for (const key of childChatKeys) {
      emitChatRow(`chat:${String(folder.id)}:${key}`, key, 1);
    }
    folderSources.push({
      id: folder.id,
      title: folder.title,
      childChatKeys,
      explicitChatKeys,
    });
  }

  // 3. Chats in NO folder — flat at depth 0 (self already emitted above).
  for (const chat of chats) {
    if (inAnyFolder.has(chat.id)) continue;
    emitChatRow(`chat:${chat.id}`, chat.id, 0);
  }

  return { rows, enumeration: { chats: chatSources, folders: folderSources } };
};
