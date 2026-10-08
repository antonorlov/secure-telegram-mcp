import { describe, expect, it } from 'vitest';
import { Api, helpers, type TelegramClient } from 'telegram';

import {
  UnicodeSanitizer,
} from '../../src/infrastructure/index.js';
import { readAccountSnapshot } from '../../src/infrastructure/telegram/gramjs-account-reader.js';

const user = new Api.User({
  id: helpers.returnBigInt(42),
  accessHash: helpers.returnBigInt(7),
  firstName: 'A\u202eB',
  username: 'alice',
  contact: true,
});

const folder = new Api.DialogFilter({
  id: 7,
  title: new Api.TextWithEntities({ text: 'W\u200bork', entities: [] }),
  pinnedPeers: [new Api.InputPeerSelf()],
  includePeers: [
    new Api.InputPeerUser({
      userId: helpers.returnBigInt(42),
      accessHash: helpers.returnBigInt(7),
    }),
  ],
  excludePeers: [],
});

describe('readAccountSnapshot', () => {
  it('maps and sanitizes dialogs/folders while skipping one malformed dialog', async () => {
    const client = {
      getDialogs: () =>
        Promise.resolve([
          {
            entity: user,
            dialog: {
              unreadCount: 2,
              unreadMentionsCount: 1,
              notifySettings: { muteUntil: Math.floor(Date.now() / 1000) + 60 },
            },
          },
          { entity: { className: 'Malformed' } },
        ]),
      invoke: () =>
        Promise.resolve(
          new Api.messages.DialogFilters({
            filters: [new Api.DialogFilterDefault(), folder],
          }),
        ),
    } as unknown as TelegramClient;

    const snapshot = await readAccountSnapshot(client, new UnicodeSanitizer());

    expect(snapshot).toEqual({
      ok: true,
      value: {
        chats: [
          {
            id: '42',
            title: 'AB',
            kind: 'user',
            username: 'alice',
            isContact: true,
            isMuted: true,
            isUnread: true,
            isArchived: false,
            hasUnreadMention: true,
          },
        ],
        folders: [
          expect.objectContaining({
            id: 7,
            title: 'Work',
            chatIds: ['me', '42'],
          }),
        ],
      },
    });
  });

  it('maps Telegram failures to an application error', async () => {
    const client = {
      getDialogs: () => Promise.reject(new Error('network failed')),
      invoke: () => Promise.resolve(new Api.messages.DialogFilters({ filters: [] })),
    } as unknown as TelegramClient;

    const snapshot = await readAccountSnapshot(client, new UnicodeSanitizer());

    expect(snapshot.ok).toBe(false);
  });
});
