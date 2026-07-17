/**
 * Forum-topic mapping — the pure translation rules the feature hangs on:
 *
 *  - `mapMessage` topic derivation: in forums the reply header doubles as
 *    topic ADDRESSING, so a top-level topic message must surface `topicId`
 *    WITHOUT a misleading `replyToMessageId` (the pre-existing bug), a genuine
 *    in-topic reply surfaces both, headerless forum messages live in General
 *    (id 1), and non-forum chats never carry a topicId.
 *  - `mapTopic`: Api.ForumTopic -> TopicDto with the title sanitized under the
 *    `topic_title` untrusted kind.
 *  - `topicReplyParams`: the write-side SSOT for InputReplyToMessage — topMsgId
 *    only alongside replyToMsgId; General (1) addressed by omission.
 *
 * All fixtures are synthetic English placeholders (never real data). Wire
 * shape is imposed the same way gramjs-mappers.test.ts does: absent optional
 * TL fields are null, not undefined.
 */
import { describe, it, expect } from 'vitest';
import { Api } from 'telegram';
import {
  mapMessage,
  mapTopic,
  topicReplyParams,
  type MessageMapDeps,
} from '../../src/infrastructure/telegram/gramjs-mappers.js';
import { UnicodeSanitizer } from '../../src/infrastructure/sanitize/unicode-sanitizer.js';
import { UntrustedTextKind } from '../../src/domain/index.js';

const sanitizer = new UnicodeSanitizer();

const depsFor = (isForum: boolean): MessageMapDeps => ({
  sanitizer,
  resolveDisplayName: (): undefined => undefined,
  isForumChat: (): boolean => isForum,
});

/** GramJS accepts plain numbers for TL `long` fields at runtime. */
const asLong = (n: number): Api.long => n as unknown as Api.long;

/** Impose the wire deserializer's shape: absent optional TL fields are null. */
const asWire = <T extends object>(value: T, nullFields: readonly string[]): T => {
  const patch: Record<string, null> = {};
  for (const f of nullFields) patch[f] = null;
  return Object.assign(value, patch);
};

const messageWith = (replyTo: Api.MessageReplyHeader | undefined): Api.Message =>
  asWire(
    new Api.Message({
      id: 100,
      peerId: new Api.PeerChannel({ channelId: asLong(1_000_000_001) }),
      date: 1_750_000_000,
      message: 'synthetic body',
      ...(replyTo !== undefined ? { replyTo } : {}),
    }),
    replyTo !== undefined
      ? ['fromId', 'fwdFrom', 'editDate', 'media']
      : ['fromId', 'fwdFrom', 'editDate', 'media', 'replyTo'],
  );

describe('mapMessage — forum topic derivation matrix', () => {
  it('forum TOP-LEVEL topic message: topicId set, NO replyToMessageId (addressing, not a reply)', () => {
    const header = asWire(
      new Api.MessageReplyHeader({ forumTopic: true, replyToMsgId: 7 }),
      ['replyToTopId', 'replyToPeerId', 'replyFrom', 'replyMedia'],
    );
    const dto = mapMessage(messageWith(header), depsFor(true));
    expect(dto.topicId).toBe(7);
    expect(dto.replyToMessageId).toBeUndefined();
  });

  it('forum IN-TOPIC reply: both topicId (replyToTopId) and replyToMessageId (the replied message)', () => {
    const header = asWire(
      new Api.MessageReplyHeader({
        forumTopic: true,
        replyToMsgId: 55,
        replyToTopId: 7,
      }),
      ['replyToPeerId', 'replyFrom', 'replyMedia'],
    );
    const dto = mapMessage(messageWith(header), depsFor(true));
    expect(dto.topicId).toBe(7);
    expect(dto.replyToMessageId).toBe(55);
  });

  it('forum message with NO reply header lives in the virtual General topic (id 1)', () => {
    const dto = mapMessage(messageWith(undefined), depsFor(true));
    expect(dto.topicId).toBe(1);
    expect(dto.replyToMessageId).toBeUndefined();
  });

  it('NON-forum reply: replyToMessageId as before, never a topicId', () => {
    const header = asWire(new Api.MessageReplyHeader({ replyToMsgId: 9 }), [
      'replyToTopId',
      'replyToPeerId',
      'replyFrom',
      'replyMedia',
    ]);
    const dto = mapMessage(messageWith(header), depsFor(false));
    expect(dto.replyToMessageId).toBe(9);
    expect(dto.topicId).toBeUndefined();
  });

  it('NON-forum plain message: neither field', () => {
    const dto = mapMessage(messageWith(undefined), depsFor(false));
    expect(dto.replyToMessageId).toBeUndefined();
    expect(dto.topicId).toBeUndefined();
  });
});

describe('mapTopic — Api.ForumTopic -> TopicDto', () => {
  const forumTopic = (over: { closed?: boolean; pinned?: boolean }): Api.ForumTopic =>
    new Api.ForumTopic({
      id: 7,
      date: 1_750_000_000,
      title: 'Planning',
      iconColor: 0,
      topMessage: 42,
      readInboxMaxId: 0,
      readOutboxMaxId: 0,
      unreadCount: 3,
      unreadMentionsCount: 0,
      unreadReactionsCount: 0,
      fromId: new Api.PeerUser({ userId: asLong(123) }),
      notifySettings: new Api.PeerNotifySettings({}),
      ...(over.closed === true ? { closed: true } : {}),
      ...(over.pinned === true ? { pinned: true } : {}),
    });

  it('maps identity, counters, and flags; title is sanitized under topic_title', () => {
    const dto = mapTopic(forumTopic({ pinned: true }), sanitizer);
    expect(dto.topicId).toBe(7);
    expect(dto.unreadCount).toBe(3);
    expect(dto.closed).toBe(false);
    expect(dto.pinned).toBe(true);
    expect(dto.lastMessageId).toBe(42);
    expect(dto.title.kind).toBe(UntrustedTextKind.TopicTitle);
    expect(dto.title.toStructured()).toEqual({ topic_title: 'Planning' });
  });

  it('normalizes wire-null flags to booleans', () => {
    const wireTopic = asWire(forumTopic({}), ['closed', 'pinned']);
    const dto = mapTopic(wireTopic, sanitizer);
    expect(dto.closed).toBe(false);
    expect(dto.pinned).toBe(false);
  });
});

describe('topicReplyParams — InputReplyToMessage field SSOT', () => {
  it('no topic, no reply -> empty (send plain)', () => {
    expect(topicReplyParams({})).toEqual({});
  });

  it('no topic, plain reply -> replyToMsgId only', () => {
    expect(topicReplyParams({ replyToMessageId: 9 })).toEqual({ replyToMsgId: 9 });
  });

  it('topic root post -> replyToMsgId = the topic id (topMsgId needs a replyTo host)', () => {
    expect(topicReplyParams({ topicId: 7 })).toEqual({ replyToMsgId: 7 });
  });

  it('reply inside a topic -> both fields', () => {
    expect(topicReplyParams({ replyToMessageId: 55, topicId: 7 })).toEqual({
      replyToMsgId: 55,
      topMsgId: 7,
    });
  });

  it('General (1) alone -> empty: the virtual topic is addressed by omission', () => {
    expect(topicReplyParams({ topicId: 1 })).toEqual({});
  });

  it('General (1) with a reply -> plain reply, no topMsgId', () => {
    expect(topicReplyParams({ replyToMessageId: 9, topicId: 1 })).toEqual({
      replyToMsgId: 9,
    });
  });
});
