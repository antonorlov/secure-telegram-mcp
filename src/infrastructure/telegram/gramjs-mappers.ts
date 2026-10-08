/**
 * Pure translation between GramJS runtime objects and the application's immutable DTOs.
 * `telegram` is imported here and in the gateway only, so no GramJS type escapes.
 * Every attacker-controlled string — message body, sender name, chat title, file name — goes
 * through the injected sanitizer and is emitted as `UntrustedText`; GramJS big-integer ids
 * convert to native `bigint` through marked-id strings.
 */
import { Api, utils } from 'telegram';
import type { UnicodeSanitizer } from '../sanitize/unicode-sanitizer.js';
import type {
  MessageDto,
  MessageReactionDto,
  MediaInfoDto,
  MediaKind,
  DialogDto,
  ChatInfoDto,
  ChatKind,
  ParticipantDto,
  TopicDto,
} from '../../application/index.js';
import {
  GENERAL_TOPIC_ID,
  PeerRefFactory,
  UntrustedTextKind,
} from '../../domain/index.js';
import type { UntrustedText } from '../../domain/index.js';

/**
 * GramJS declares optional TL fields as `T
 * undefined`, but the runtime deserializer materializes an absent flag as `null` — the declared
 * type lies, so a bare `!== undefined` guard passes `null` through. That crashed `mapMessage`
 * on channel posts, whose `fromId` is null, and silently mislabeled every post as forwarded.
 * This helper is the ONE place the quirk is normalized: guard raw TL fields with
 * `tlOptional(...) !== undefined`. GramJS custom getters such as `msg.document` do return real
 * `undefined`.
 */
const tlOptional = <T>(value: T | undefined): T | undefined =>
  value ?? undefined;

export type ResolvedEntity =
  | Api.User
  | Api.Chat
  | Api.Channel
  | Api.ChatForbidden
  | Api.ChannelForbidden;

export const isResolvedEntity = (entity: unknown): entity is ResolvedEntity =>
  entity instanceof Api.User ||
  entity instanceof Api.Chat ||
  entity instanceof Api.Channel ||
  entity instanceof Api.ChatForbidden ||
  entity instanceof Api.ChannelForbidden;

// Throws only on a structurally invalid peer — a programmer error; callers guard with try/catch
// at the I/O boundary.
export const canonicalIdOf = (peer: Api.TypePeer | ResolvedEntity): bigint =>
  BigInt(utils.getPeerId(peer));

export const unixToIso = (seconds: number): string =>
  new Date(seconds * 1000).toISOString();

export const usernameOf = (entity: ResolvedEntity): string | undefined => {
  if (entity instanceof Api.User || entity instanceof Api.Channel) {
    /**
     * GramJS hands back `null`, not `undefined`, for a missing username, so guard on the string
     * type: a bare `!== undefined` check lets `null.length` throw, which used to abort the
     * whole dialog enumeration.
     */
    if (typeof entity.username !== 'string' || entity.username.length === 0) {
      return undefined;
    }
    const parsed = PeerRefFactory.fromUsername(entity.username);
    return parsed.ok && parsed.value.kind === 'username'
      ? parsed.value.username
      : undefined;
  }
  return undefined;
};

export const isContactOf = (entity: ResolvedEntity): boolean =>
  entity instanceof Api.User && entity.contact === true;

export const isForumOf = (entity: ResolvedEntity): boolean =>
  entity instanceof Api.Channel && entity.forum === true;

export const chatKindOf = (entity: ResolvedEntity): ChatKind => {
  if (entity instanceof Api.User) {
    return entity.bot === true ? 'bot' : 'user';
  }
  if (entity instanceof Api.Channel) {
    return entity.megagroup === true ? 'supergroup' : 'channel';
  }
  if (entity instanceof Api.ChannelForbidden) {
    return entity.megagroup === true ? 'supergroup' : 'channel';
  }
  // Api.Chat | Api.ChatForbidden — basic (non-super) groups.
  return 'group';
};

/**
 * Telegram deleted accounts clear first/last name and username, so `utils.getDisplayName`
 * returns '' — surface "Deleted Account", and a generic fallback for any other unnamed entity,
 * so a picker row or chat title is never an empty `@`.
 */
export const displayLabelOf = (entity: ResolvedEntity): string => {
  const name = utils.getDisplayName(entity);
  if (name.trim().length > 0) {
    return name;
  }
  return entity instanceof Api.User && entity.deleted === true
    ? '[Deleted account]'
    : '[Unnamed]';
};

export const titleOf = (
  entity: ResolvedEntity,
  sanitizer: UnicodeSanitizer,
): UntrustedText =>
  sanitizer.sanitize(UntrustedTextKind.ChatTitle, displayLabelOf(entity));

export const displayNameOf = (
  entity: ResolvedEntity,
  sanitizer: UnicodeSanitizer,
): UntrustedText =>
  sanitizer.sanitize(UntrustedTextKind.SenderDisplayName, displayLabelOf(entity));

const membersCountOf = (entity: ResolvedEntity): number | undefined => {
  if (entity instanceof Api.Channel || entity instanceof Api.Chat) {
    return typeof entity.participantsCount === 'number'
      ? entity.participantsCount
      : undefined;
  }
  return undefined;
};

export const mapChatInfo = (
  entity: ResolvedEntity,
  sanitizer: UnicodeSanitizer,
): ChatInfoDto => {
  const membersCount = membersCountOf(entity);
  return Object.freeze({
    chatId: canonicalIdOf(entity).toString(),
    title: titleOf(entity, sanitizer),
    kind: chatKindOf(entity),
    isBroadcast: entity instanceof Api.Channel && entity.broadcast === true,
    isForum: isForumOf(entity),
    ...(membersCount !== undefined ? { membersCount } : {}),
  });
};

export const mapDialog = (
  input: {
    readonly entity: ResolvedEntity;
    readonly unreadCount: number;
    readonly pinned: boolean;
  },
  sanitizer: UnicodeSanitizer,
): DialogDto =>
  Object.freeze({
    chatId: canonicalIdOf(input.entity).toString(),
    title: titleOf(input.entity, sanitizer),
    kind: chatKindOf(input.entity),
    unreadCount: input.unreadCount,
    pinned: input.pinned,
    isForum: isForumOf(input.entity),
  });

export const mapParticipant = (
  user: Api.User,
  sanitizer: UnicodeSanitizer,
): ParticipantDto => {
  const username = usernameOf(user);
  return Object.freeze({
    id: canonicalIdOf(user).toString(),
    displayName: displayNameOf(user, sanitizer),
    ...(username !== undefined ? { username } : {}),
    isBot: user.bot === true,
  });
};

export const mapTopic = (
  topic: Api.ForumTopic,
  sanitizer: UnicodeSanitizer,
): TopicDto =>
  Object.freeze({
    topicId: topic.id,
    title: sanitizer.sanitize(UntrustedTextKind.TopicTitle, topic.title),
    unreadCount: topic.unreadCount,
    closed: topic.closed === true,
    pinned: topic.pinned === true,
    lastMessageId: topic.topMessage,
  });

/**
 * The two TL quirks every topic-addressed write shares: `topMsgId` only takes effect alongside
 * `replyToMsgId`, and the virtual General topic (id 1) has no root message, so it must be
 * addressed by omitting the topic entirely.
 */
export const topicReplyParams = (input: {
  readonly replyToMessageId?: number | undefined;
  readonly topicId?: number | undefined;
}): { readonly replyToMsgId?: number; readonly topMsgId?: number } => {
  const { replyToMessageId, topicId } = input;
  if (topicId === undefined || topicId === GENERAL_TOPIC_ID) {
    return Object.freeze(
      replyToMessageId !== undefined ? { replyToMsgId: replyToMessageId } : {},
    );
  }
  return Object.freeze(
    replyToMessageId !== undefined
      ? { replyToMsgId: replyToMessageId, topMsgId: topicId }
      : { replyToMsgId: topicId },
  );
};

const mediaKindOf = (msg: Api.Message): MediaKind => {
  if (msg.sticker !== undefined) return 'sticker';
  if (msg.voice !== undefined) return 'voice';
  if (
    msg.videoNote !== undefined ||
    msg.video !== undefined ||
    msg.gif !== undefined
  ) {
    return 'video';
  }
  if (msg.audio !== undefined) return 'audio';
  if (msg.photo !== undefined) return 'photo';
  if (msg.document !== undefined) return 'document';
  return 'other';
};

// Metadata only — no bytes ever leave the gateway; download egress is deferred.
export const mapMediaInfo = (
  msg: Api.Message,
  sanitizer: UnicodeSanitizer,
): MediaInfoDto | undefined => {
  if (tlOptional(msg.media) === undefined) {
    return undefined;
  }
  const kind = mediaKindOf(msg);
  const doc = msg.document;

  let mimeType: UntrustedText | undefined;
  let sizeBytes: number | undefined;
  let fileName: UntrustedText | undefined;
  let durationSeconds: number | undefined;
  let width: number | undefined;
  let height: number | undefined;

  if (doc !== undefined) {
    mimeType =
      doc.mimeType.length > 0
        ? sanitizer.sanitize(UntrustedTextKind.MimeType, doc.mimeType)
        : undefined;
    const parsed = Number(doc.size.toString());
    sizeBytes = Number.isFinite(parsed) ? parsed : undefined;
    for (const attr of doc.attributes) {
      if (attr instanceof Api.DocumentAttributeFilename) {
        fileName = sanitizer.sanitize(UntrustedTextKind.Body, attr.fileName);
      } else if (attr instanceof Api.DocumentAttributeVideo) {
        durationSeconds = attr.duration;
        width = attr.w;
        height = attr.h;
      } else if (attr instanceof Api.DocumentAttributeAudio) {
        durationSeconds = attr.duration;
      } else if (attr instanceof Api.DocumentAttributeImageSize) {
        width = attr.w;
        height = attr.h;
      }
    }
  }

  return Object.freeze({
    kind,
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(fileName !== undefined ? { fileName } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  });
};

// Hard cap on distinct reaction buckets surfaced per message (output discipline).
const MAX_REACTIONS = 20;

// Only `ReactionEmoji` buckets are surfaced: custom-emoji reactions carry an opaque document id
// rather than a grapheme. Each emoticon is sanitized and the list is length-capped.
export const mapReactions = (
  msg: Api.Message,
  sanitizer: UnicodeSanitizer,
): readonly MessageReactionDto[] | undefined => {
  const reactions = tlOptional(msg.reactions);
  if (reactions === undefined) {
    return undefined;
  }
  const out: MessageReactionDto[] = [];
  for (const bucket of reactions.results) {
    if (out.length >= MAX_REACTIONS) {
      break;
    }
    if (bucket.reaction instanceof Api.ReactionEmoji) {
      // The emoticon is Telegram-originated -> route through the sanitizer, then
      // carry only the cleaned scalar (a short grapheme, not instruction-bearing prose).
      const emoji = sanitizer.sanitize(
        UntrustedTextKind.Body,
        bucket.reaction.emoticon,
      ).sanitizedValue;
      if (emoji.length > 0) {
        out.push({ emoji, count: bucket.count });
      }
    }
  }
  return out.length > 0 ? out : undefined;
};

// Collaborators the message mapper needs from the (scoped) gateway.
export interface MessageMapDeps {
  readonly sanitizer: UnicodeSanitizer;
  // Scoped-cache-only name lookup; never triggers a network fetch.
  readonly resolveDisplayName: (canonicalId: bigint) => UntrustedText | undefined;
  // Scoped-cache-only forum check; drives topicId derivation for General.
  readonly isForumChat: (canonicalId: bigint) => boolean;
}

/**
 * Derive {topicId, replyToMessageId} from a message's reply header. In forums
 * the header doubles as topic addressing: a TOP-LEVEL topic message "replies"
 * to the topic's root service message (`replyToMsgId` = topic id, no
 * `replyToTopId`) — that is addressing, not a reply, so replyToMessageId must
 * stay absent. A genuine in-topic reply carries both (`replyToTopId` = topic).
 * Forum messages with no header live in the virtual General topic (id 1).
 */
const topicFieldsOf = (
  msg: Api.Message,
  isForum: boolean,
): { readonly topicId?: number; readonly replyToMessageId?: number } => {
  const header =
    msg.replyTo instanceof Api.MessageReplyHeader ? msg.replyTo : undefined;
  const replyToMsgId =
    header !== undefined ? tlOptional(header.replyToMsgId) : undefined;
  if (header?.forumTopic !== true) {
    return {
      ...(isForum ? { topicId: GENERAL_TOPIC_ID } : {}),
      ...(replyToMsgId !== undefined ? { replyToMessageId: replyToMsgId } : {}),
    };
  }
  const topId = tlOptional(header.replyToTopId);
  const topicId = topId ?? replyToMsgId;
  return {
    ...(topicId !== undefined ? { topicId } : {}),
    ...(topId !== undefined && replyToMsgId !== undefined
      ? { replyToMessageId: replyToMsgId }
      : {}),
  };
};

// Map a concrete `Api.Message` to the read-side Message DTO.
export const mapMessage = (
  msg: Api.Message,
  deps: MessageMapDeps,
): MessageDto => {
  const canonicalChatId = canonicalIdOf(msg.peerId);
  const chatId = canonicalChatId.toString();

  // Channel posts have NO individual author: their `fromId` is null at
  // runtime (the post speaks as the channel). Absent sender -> absent fields.
  let senderId: string | undefined;
  let senderDisplayName: UntrustedText | undefined;
  const fromId = tlOptional(msg.fromId);
  if (fromId !== undefined) {
    const sender = canonicalIdOf(fromId);
    senderId = sender.toString();
    senderDisplayName = deps.resolveDisplayName(sender);
  }

  const text =
    msg.message.length > 0
      ? deps.sanitizer.sanitize(UntrustedTextKind.Body, msg.message)
      : undefined;

  const topicFields = topicFieldsOf(msg, deps.isForumChat(canonicalChatId));

  const media = mapMediaInfo(msg, deps.sanitizer);
  const reactions = mapReactions(msg, deps.sanitizer);

  const editDate = tlOptional(msg.editDate);

  return Object.freeze({
    messageId: msg.id,
    chatId,
    dateIso: unixToIso(msg.date),
    forwarded: tlOptional(msg.fwdFrom) !== undefined,
    ...(senderId !== undefined ? { senderId } : {}),
    ...(senderDisplayName !== undefined ? { senderDisplayName } : {}),
    ...(editDate !== undefined ? { editedDateIso: unixToIso(editDate) } : {}),
    ...(text !== undefined ? { text } : {}),
    ...topicFields,
    ...(media !== undefined ? { media } : {}),
    ...(reactions !== undefined ? { reactions } : {}),
  });
};
