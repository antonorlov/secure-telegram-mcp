/**
 * telegram-peer-id — the tiny, PURE mapping from a GramJS `InputPeer` to OUR
 * canonical `bigint` peer identity (the value carried by `ChatId`). GramJS types
 * are referenced only at the parameter boundary and never escape infrastructure.
 *
 * Canonical form is the bot-API "marked" id (the convention `ChatId` and the
 * GramJS gateway use): users are positive, basic groups are negated, and
 * channels/supergroups are prefixed `-100…`. Ids are converted via their decimal
 * string because channel ids exceed Number.MAX_SAFE_INTEGER.
 */
import type { Api } from 'telegram';

/** Channel/supergroup marker: a channel id `c` maps to `-100…c` == MARK - c. */
const CHANNEL_ID_MARK = -1_000_000_000_000n;

/**
 * Map a GramJS `InputPeer` to its canonical `bigint` id (pure, synchronous).
 *
 * Returns `undefined` for peers that carry no self-contained id:
 *  - `InputPeerSelf` — needs the authenticated account; callers resolve it
 *    themselves (folder resolver via `getSelfId`, setup via the `'me'` key),
 *  - `InputPeerEmpty` — an empty/no-op peer,
 *  - any unrecognised future variant — FAIL-CLOSED: contribute nothing rather
 *    than guess an identity.
 */
export const canonicalPeerIdFromInputPeer = (
  peer: Api.TypeInputPeer,
): bigint | undefined => {
  switch (peer.className) {
    case 'InputPeerUser':
    case 'InputPeerUserFromMessage':
      return BigInt(peer.userId.toString());
    case 'InputPeerChat':
      return -BigInt(peer.chatId.toString());
    case 'InputPeerChannel':
    case 'InputPeerChannelFromMessage':
      return CHANNEL_ID_MARK - BigInt(peer.channelId.toString());
    default:
      return undefined;
  }
};

/**
 * The canonical SETUP membership key of an `InputPeer`: the marked-id string that
 * lines up with `SetupChat.id` (`canonicalIdOf(...).toString()`), EXCEPT that the
 * authenticated account (`InputPeerSelf`) normalises to the synthetic `'me'` key
 * so a folder that pins Saved Messages matches the picker's synthetic self row.
 */
const setupPeerKey = (peer: Api.TypeInputPeer): string | undefined => {
  if (peer.className === 'InputPeerSelf') return 'me';
  return canonicalPeerIdFromInputPeer(peer)?.toString();
};

/**
 * The canonical member chat-keys of a Telegram dialog filter (folder): the set
 * `pinned ∪ included − excluded`, each as a `SetupChat.id`-shaped marked-id string
 * (self -> `'me'`), de-duped in stable order. The default (all-chats) filter and
 * empty/unknown peers contribute nothing (fail-closed).
 */
export const dialogFilterChatKeys = (
  filter: Api.TypeDialogFilter,
): readonly string[] => {
  if (filter.className === 'DialogFilterDefault') return [];

  const excluded = new Set<string>();
  if (filter.className === 'DialogFilter') {
    for (const peer of filter.excludePeers) {
      const key = setupPeerKey(peer);
      if (key !== undefined) excluded.add(key);
    }
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const peer of [...filter.pinnedPeers, ...filter.includePeers]) {
    const key = setupPeerKey(peer);
    if (key !== undefined && !excluded.has(key) && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
};

/**
 * A folder's category + status flags. Mirrors TDLib `chatFolder.include_*` /
 * `exclude_*` — VERIFIED identical across Telegram Desktop `ChatFilter::contains`
 * and Telegram Web `folderManager.isChatInFolder`. `undefined` for the default
 * filter or an imported shared chatlist (no flag-based membership — explicit only).
 */
export interface DialogFilterFlags {
  readonly contacts: boolean;
  readonly nonContacts: boolean;
  readonly groups: boolean;
  readonly broadcasts: boolean;
  readonly bots: boolean;
  readonly excludeMuted: boolean;
  readonly excludeRead: boolean;
  readonly excludeArchived: boolean;
}

export const dialogFilterFlags = (
  filter: Api.TypeDialogFilter,
): DialogFilterFlags | undefined => {
  if (filter.className !== 'DialogFilter') return undefined;
  return {
    contacts: filter.contacts === true,
    nonContacts: filter.nonContacts === true,
    groups: filter.groups === true,
    broadcasts: filter.broadcasts === true,
    bots: filter.bots === true,
    excludeMuted: filter.excludeMuted === true,
    excludeRead: filter.excludeRead === true,
    excludeArchived: filter.excludeArchived === true,
  };
};

/** A folder's explicitly EXCLUDED peer keys (the "never" set), de-duped. */
export const dialogFilterExcludeKeys = (
  filter: Api.TypeDialogFilter,
): readonly string[] => {
  if (filter.className !== 'DialogFilter') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const peer of filter.excludePeers) {
    const key = setupPeerKey(peer);
    if (key !== undefined && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
};
