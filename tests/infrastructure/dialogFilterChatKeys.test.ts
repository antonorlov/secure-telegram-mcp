/**
 * dialogFilterChatKeys — the PURE folder-membership arithmetic the setup client
 * exposes so the picker can build the folder->chat hierarchy. Pins: `pinned ∪
 * included − excluded`, canonical marked-id strings that line up with
 * `SetupChat.id`, self normalised to 'me', de-dup + fail-closed on empty peers,
 * and the all-chats default filter contributing nothing.
 */
import { describe, it, expect } from 'vitest';
import { Api, helpers } from 'telegram';

import { dialogFilterChatKeys } from '../../src/infrastructure/telegram/telegram-peer-id.js';

const inputUser = (id: string): Api.TypeInputPeer =>
  new Api.InputPeerUser({
    userId: helpers.returnBigInt(id),
    accessHash: helpers.returnBigInt('0'),
  });
const inputBasicGroup = (id: string): Api.TypeInputPeer =>
  new Api.InputPeerChat({ chatId: helpers.returnBigInt(id) });
const inputChannel = (id: string): Api.TypeInputPeer =>
  new Api.InputPeerChannel({
    channelId: helpers.returnBigInt(id),
    accessHash: helpers.returnBigInt('0'),
  });
const inputSelf = (): Api.TypeInputPeer => new Api.InputPeerSelf();
const inputEmpty = (): Api.TypeInputPeer => new Api.InputPeerEmpty();

const filter = (config: {
  readonly pinned?: readonly Api.TypeInputPeer[];
  readonly include?: readonly Api.TypeInputPeer[];
  readonly exclude?: readonly Api.TypeInputPeer[];
}): Api.TypeDialogFilter =>
  new Api.DialogFilter({
    id: 7,
    title: new Api.TextWithEntities({ text: 'Work', entities: [] }),
    pinnedPeers: [...(config.pinned ?? [])],
    includePeers: [...(config.include ?? [])],
    excludePeers: [...(config.exclude ?? [])],
  });

describe('dialogFilterChatKeys', () => {
  it('unions pinned + included as SetupChat.id-shaped marked-id strings', () => {
    const keys = dialogFilterChatKeys(
      filter({ pinned: [inputChannel('100')], include: [inputUser('42'), inputBasicGroup('9')] }),
    );
    // channel -> -100…, user -> positive, basic group -> negated (marked-id SSOT).
    expect(keys).toEqual(['-1000000000100', '42', '-9']);
  });

  it('subtracts excluded peers and normalises self to "me"', () => {
    const keys = dialogFilterChatKeys(
      filter({
        pinned: [inputSelf()],
        include: [inputUser('42'), inputUser('99')],
        exclude: [inputUser('99')],
      }),
    );
    expect(keys).toEqual(['me', '42']);
  });

  it('de-dups repeated peers and drops empty/no-id peers (fail-closed)', () => {
    const keys = dialogFilterChatKeys(
      filter({ pinned: [inputUser('42'), inputEmpty()], include: [inputUser('42')] }),
    );
    expect(keys).toEqual(['42']);
  });

  it('the all-chats default filter contributes no members', () => {
    expect(dialogFilterChatKeys(new Api.DialogFilterDefault())).toEqual([]);
  });
});
