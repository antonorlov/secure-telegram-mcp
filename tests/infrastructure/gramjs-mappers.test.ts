/**
 * Regressions for the TL runtime-null quirk: GramJS *declares* optional TL
 * fields as `T | undefined`, but its generated `fromReader` materializes an
 * ABSENT flag field as `null` (tl/api.js: `else { args[argName] = null; }`).
 * Locally-constructed Api objects carry `undefined`, so these tests impose
 * `null` explicitly to mirror the WIRE shape — the one production sees.
 *
 * Bites pinned here:
 *  - `usernameOf`: `null.length` threw and aborted listing ALL dialogs.
 *  - `mapMessage`: null `fromId` on channel posts -> `utils.getPeerId(null)`
 *    -> "Cannot use 'in' operator to search for 'className' in null" (hung
 *    get_messages); null `fwdFrom` mislabeled every post `forwarded: true`;
 *    null `editDate` stamped unedited messages with a 1970 `editedDateIso`;
 *    null `media` attached a phantom media DTO to text messages.
 */
import { describe, it, expect } from 'vitest';
import { Api } from 'telegram';

import {
  displayLabelOf,
  mapMessage,
  mapMediaInfo,
  mapReactions,
  usernameOf,
} from '../../src/infrastructure/telegram/gramjs-mappers.js';
import { UnicodeSanitizer } from '../../src/infrastructure/sanitize/unicode-sanitizer.js';
import { UntrustedTextKind } from '../../src/domain/index.js';

// A minimal object carrying Api.User's prototype (so `instanceof Api.User` holds)
// with just the field under test — no real id / big-integer needed. GramJS hands
// back `null` (not undefined) for a missing username, which is the crash case.
const userWith = (username: string | null): Api.User => {
  const user = Object.create(Api.User.prototype) as Api.User;
  (user as unknown as { username: string | null }).username = username;
  return user;
};

describe('usernameOf — null-username safety', () => {
  it('treats a NULL username as "no username" without throwing', () => {
    const user = userWith(null);
    expect(() => usernameOf(user)).not.toThrow();
    expect(usernameOf(user)).toBeUndefined();
  });

  it('still returns a present, non-empty username', () => {
    expect(usernameOf(userWith('alice'))).toBe('alice');
  });

  it('drops values outside the domain username grammar', () => {
    expect(usernameOf(userWith('bad\u202ename'))).toBeUndefined();
    expect(usernameOf(userWith('x'))).toBeUndefined();
  });
});

describe('displayLabelOf — never a blank row', () => {
  const userEntity = (fields: Record<string, unknown>): Api.User => {
    const user = Object.create(Api.User.prototype) as Api.User;
    Object.assign(user, fields);
    return user;
  };

  it('labels a DELETED account "[Deleted account]" (Telegram clears its name)', () => {
    const deleted = userEntity({ firstName: '', lastName: '', deleted: true });
    expect(displayLabelOf(deleted)).toBe('[Deleted account]');
  });

  it('returns the real name when present', () => {
    // Synthetic placeholder names only — never real contacts.
    expect(displayLabelOf(userEntity({ firstName: 'Ada' }))).toBe('Ada');
    expect(
      displayLabelOf(userEntity({ firstName: 'Ada', lastName: 'Lovelace' })),
    ).toBe('Ada Lovelace');
  });

  it('falls back to "[Unnamed]" for an unnamed but NOT-deleted entity', () => {
    expect(displayLabelOf(userEntity({ firstName: '', lastName: '' }))).toBe('[Unnamed]');
  });
});

const sanitizer = new UnicodeSanitizer();

const deps = {
  sanitizer,
  resolveDisplayName: (id: bigint): ReturnType<typeof sanitizer.sanitize> | undefined =>
    id === 123n
      ? sanitizer.sanitize(UntrustedTextKind.SenderDisplayName, 'Alice')
      : undefined,
  isForumChat: (): boolean => false,
};

/**
 * GramJS accepts plain numbers for TL `long` fields at runtime (verified:
 * `utils.getPeerId` maps them identically); tests use them to avoid importing
 * the transitive `big-integer` dependency.
 */
const asLong = (n: number): Api.long => n as unknown as Api.long;

/** Impose the wire deserializer's shape: absent optional TL fields are null. */
const asWire = (
  msg: Api.Message,
  nullFields: readonly string[],
): Api.Message => {
  const patch: Record<string, null> = {};
  for (const f of nullFields) patch[f] = null;
  return Object.assign(msg as object, patch) as unknown as Api.Message;
};

const channelPost = (): Api.Message =>
  asWire(
    new Api.Message({
      id: 42,
      peerId: new Api.PeerChannel({ channelId: asLong(1_000_000_001) }),
      date: 1_750_000_000,
      message: 'hello from the channel',
    }),
    ['fromId', 'fwdFrom', 'editDate', 'media'],
  );

describe('mapMessage — wire-shaped messages (absent TL fields are null)', () => {
  it('maps a channel post (null fromId/fwdFrom/editDate/media) without crashing or fabricating fields', () => {
    const dto = mapMessage(channelPost(), deps);

    expect(dto.chatId).toBe('-1001000000001');
    expect(dto.messageId).toBe(42);
    expect(dto.text).toBeDefined();
    // null fromId = the post speaks as the channel: NO sender fields.
    expect(dto.senderId).toBeUndefined();
    expect(dto.senderDisplayName).toBeUndefined();
    // null fwdFrom must read as NOT forwarded (was: forwarded === true).
    expect(dto.forwarded).toBe(false);
    // null editDate must not fabricate a 1970 timestamp.
    expect('editedDateIso' in dto).toBe(false);
    // null media must not attach a phantom media DTO.
    expect(dto.media).toBeUndefined();
  });

  it('still maps present sender/editDate (nulls only where truly absent)', () => {
    const msg = asWire(
      new Api.Message({
        id: 7,
        peerId: new Api.PeerChannel({ channelId: asLong(1_000_000_001) }),
        fromId: new Api.PeerUser({ userId: asLong(123) }),
        date: 1_750_000_000,
        editDate: 1_750_000_100,
        message: 'edited reply',
      }),
      ['fwdFrom', 'media'],
    );
    const dto = mapMessage(msg, deps);

    expect(dto.senderId).toBe('123');
    expect(dto.senderDisplayName).toBeDefined(); // from the scoped cache
    expect(dto.editedDateIso).toBe(
      new Date(1_750_000_100 * 1000).toISOString(),
    );
    expect(dto.forwarded).toBe(false);
  });
});

describe('mapMediaInfo — wire-shaped messages', () => {
  it('returns undefined for a text message whose media is wire-null', () => {
    expect(mapMediaInfo(channelPost(), sanitizer)).toBeUndefined();
  });
});

/** A bare message carrying only the `reactions` field under test. */
const withReactions = (reactions: unknown): Api.Message => {
  const msg = Object.create(Api.Message.prototype) as Api.Message;
  (msg as unknown as { reactions: unknown }).reactions = reactions;
  return msg;
};

describe('mapReactions — standard-emoji tallies only, sanitized + capped', () => {
  it('maps ReactionEmoji buckets to {emoji, count} and SKIPS custom-emoji reactions', () => {
    // A custom-emoji reaction carries a document id, not a grapheme — it is skipped.
    const custom = Object.create(Api.ReactionCustomEmoji.prototype) as Api.ReactionCustomEmoji;
    const result = mapReactions(
      withReactions({
        results: [
          { reaction: new Api.ReactionEmoji({ emoticon: 'A' }), count: 3 },
          { reaction: custom, count: 9 },
          { reaction: new Api.ReactionEmoji({ emoticon: 'B' }), count: 1 },
        ],
      }),
      sanitizer,
    );
    expect(result).toEqual([
      { emoji: 'A', count: 3 },
      { emoji: 'B', count: 1 },
    ]);
  });

  it('returns undefined when the message carries no reactions (wire-null)', () => {
    expect(mapReactions(withReactions(null), sanitizer)).toBeUndefined();
  });

  it('returns undefined when only custom-emoji reactions are present', () => {
    const custom = Object.create(Api.ReactionCustomEmoji.prototype) as Api.ReactionCustomEmoji;
    expect(
      mapReactions(
        withReactions({ results: [{ reaction: custom, count: 4 }] }),
        sanitizer,
      ),
    ).toBeUndefined();
  });

  it('caps the surfaced bucket list (output discipline)', () => {
    const results = Array.from({ length: 25 }, (_v, i) => ({
      reaction: new Api.ReactionEmoji({ emoticon: 'A' }),
      count: i,
    }));
    const mapped = mapReactions(withReactions({ results }), sanitizer);
    expect(mapped?.length).toBeLessThanOrEqual(20);
  });
});
