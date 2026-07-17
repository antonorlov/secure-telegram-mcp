/**
 * Config <-> picker FOLDER PROJECTION round-trip — pins the folder-as-scope-unit
 * seam of the lossless mapper (the axis the flat chat-only tests don't exercise):
 *
 *  - folder-as-scope -> `folders[]`: a folder picked AS A UNIT projects to a
 *    config `folders[]` ref (canonical id form) and its member chats are NOT
 *    re-listed in `chats[]` (de-duped / covered).
 *  - drilled-in chats -> `chats[]` / `chatOverrides[]`: folder children picked
 *    INDIVIDUALLY (no folder scope) project as standalone chats, carrying any
 *    per-chat override.
 *  - LOSSLESS incl. hand-authored ref preservation: a mixed hand-written scope
 *    (folder + individual chats + a folder-covered override) round-trips
 *    field-for-field, and a hand-authored `@username` ref is never clobbered to
 *    a numeric id.
 *  - re-hydrate pre-checks FOLDERS **and** CHATS: hydrating a mixed scope
 *    pre-marks `folderScope`, pre-checks both folder-member and individually
 *    listed chats, and pre-sets overrides — while an unresolvable folder ref is
 *    fail-closed (default-deny), not a phantom scope.
 *
 * Drives the PURE mapper directly (no Ink/React). Lives with the infra suite as
 * the end-to-end config<->picker contract check for folder membership.
 */
import { describe, it, expect } from 'vitest';

import {
  hydratePickerSelection,
  projectPickerSelection,
  type HydrateInput,
  type PickerEnumeration,
  type ProjectedScope,
} from '../../src/presentation/cli/picker/index.js';
import type { ValidatedScope } from '../../src/config/index.js';
import { ChatId, PeerRefFactory, type PeerRef } from '../../src/domain/index.js';
import { unwrap } from '../../src/shared/result.js';

// Fixture helpers — domain refs built the same way the schema transforms build them.
const idRef = (raw: string): PeerRef =>
  PeerRefFactory.fromId(unwrap(ChatId.fromString(raw)));
const userRef = (name: string): PeerRef => ({ kind: 'username', username: name });
const ME: PeerRef = { kind: 'me' };

// A live enumeration mixing every chat-ref FORM (me / id / username) across two
// folders. `childChatKeys` are canonical id `ChatKey`s (as `dialogFilterChatKeys`
// emits), so a username-referenced chat still joins its folder by its id key '20'.
const enumeration: PickerEnumeration = {
  chats: [
    { chatKey: 'me', ref: ME, title: 'Saved Messages' },
    { chatKey: '10', ref: idRef('10'), title: 'Alpha' },
    { chatKey: '20', ref: userRef('alice'), title: 'Alice', username: 'alice' },
    { chatKey: '-1001234', ref: idRef('-1001234'), title: 'Vendor Channel' },
  ],
  folders: [
    { id: 5, title: 'Work', childChatKeys: ['10', '20'] },
    { id: 8, title: 'Vendors', childChatKeys: ['-1001234'] },
  ],
};

const scope = (over: Partial<ValidatedScope> = {}): ValidatedScope => ({
  chats: [],
  folders: [],
  chatOverrides: [],
  ...over,
});

// The verb TIERS each access bit expands to on projection (read = passive + media
// egress; write = the full write tier). A hand-authored narrower set collapses to the
// tier on a picker round-trip (the 2-bit model's documented contract).
const R_TIER = ['read', 'read_media'];
const W_TIER = ['send', 'draft', 'delete', 'mark_read', 'forward', 'react'];
const RW_TIER = [...R_TIER, ...W_TIER];

// Convenience: full hydrate -> project round-trip over the shared enumeration.
const roundTrip = (input: Omit<HydrateInput, 'enumeration'>): ProjectedScope =>
  projectPickerSelection(
    hydratePickerSelection({ ...input, enumeration }),
    enumeration,
  );

describe('folder-as-scope-unit -> folders[]', () => {
  it('projects a scoped folder to a folders[] ref and does NOT re-list its covered chats', () => {
    const projected = roundTrip({
      groupVerbs: ['read'],
      scope: scope({ folders: [{ kind: 'id', id: 5 }] }),
    });
    expect(projected.folders).toEqual([{ kind: 'id', id: 5 }]);
    expect(projected.chats).toEqual([]); // '10' + '20' are folder-covered, not standalone
    expect(projected.chatOverrides).toEqual([]);
    expect(projected.groupVerbs).toEqual(R_TIER);
  });

  it('resolves a title-form folders[] ref and re-projects it as the canonical id form', () => {
    const projected = roundTrip({
      groupVerbs: ['read'],
      scope: scope({ folders: [{ kind: 'title', title: 'Vendors' }] }),
    });
    // A hand-authored title ref round-trips to the robust numeric identity (id 8).
    expect(projected.folders).toEqual([{ kind: 'id', id: 8 }]);
    expect(projected.chats).toEqual([]);
  });

  it('preserves a scoped folder whose live membership is not enumerated (empty childChatKeys) — no silent drop', () => {
    // Folder 5 exists in config scope but, at edit time, none of its members are
    // in the enumerated dialog list (archived / not returned by getDialogs). The
    // config-authored `folders: [5]` ref must survive an untouched-edit re-save.
    const emptyEnum: PickerEnumeration = {
      chats: enumeration.chats,
      folders: [{ id: 5, title: 'Work', childChatKeys: [] }],
    };
    const projected = projectPickerSelection(
      hydratePickerSelection({
        groupVerbs: ['read'],
        scope: scope({ folders: [{ kind: 'id', id: 5 }] }),
        enumeration: emptyEnum,
      }),
      emptyEnum,
    );
    expect(projected.folders).toEqual([{ kind: 'id', id: 5 }]);
    expect(projected.chats).toEqual([]);
  });

  it('projects both folders when the scope names both (writable verbs -> overrides)', () => {
    const projected = roundTrip({
      groupVerbs: ['read', 'send'],
      scope: scope({ folders: [{ kind: 'id', id: 5 }, { kind: 'id', id: 8 }] }),
    });
    expect(projected.folders).toEqual([
      { kind: 'id', id: 5 },
      { kind: 'id', id: 8 },
    ]);
    expect(projected.chats).toEqual([]);
    // The projected group verbs are the CANONICAL read-only default; the writable
    // group access hydrated into explicit rw bits, so every folder member
    // re-emits as a per-chat override (tier-stable, not byte-identical).
    expect(projected.groupVerbs).toEqual(R_TIER);
    expect(projected.chatOverrides).toEqual([
      { peer: idRef('10'), verbs: RW_TIER },
      { peer: userRef('alice'), verbs: RW_TIER },
      { peer: idRef('-1001234'), verbs: RW_TIER },
    ]);
  });
});

describe('drilled-in chats -> chats[] / chatOverrides[]', () => {
  it('projects folder children picked INDIVIDUALLY (no folder scope) as standalone chats[]', () => {
    const projected = roundTrip({
      groupVerbs: ['read'],
      // The same chats folder 5 groups, but listed as bare chats (no folders[]).
      scope: scope({ chats: [idRef('10'), userRef('alice')] }),
    });
    expect(projected.folders).toEqual([]); // membership-by-coincidence is NOT a folder
    expect(projected.chats).toEqual([idRef('10'), userRef('alice')]);
  });

  it('carries a drilled-in chat’s per-chat override into chatOverrides[]', () => {
    const projected = roundTrip({
      groupVerbs: ['read'],
      scope: scope({
        chats: [idRef('10')],
        chatOverrides: [{ peer: idRef('10'), verbs: ['read', 'send'] }],
      }),
    });
    expect(projected.folders).toEqual([]);
    expect(projected.chats).toEqual([idRef('10')]);
    expect(projected.chatOverrides).toEqual([
      { peer: idRef('10'), verbs: RW_TIER },
    ]);
  });
});

describe('lossless round-trip incl. hand-authored ref preservation', () => {
  it('preserves a hand-authored @username chat ref (never clobbered to a numeric id)', () => {
    const projected = roundTrip({
      groupVerbs: ['read'],
      scope: scope({ chats: [userRef('alice')] }),
    });
    // The chat resolves to id '20', but its config FORM stays the username ref.
    expect(projected.chats).toEqual([userRef('alice')]);
  });

  it('round-trips a mixed scope (folder + individual chats + folder-covered override) losslessly', () => {
    const mixed = scope({
      chats: [ME, idRef('-1001234')], // individual picks
      folders: [{ kind: 'id', id: 5 }], // folder scope covers '10' + '20'
      // Override on 'alice' (id '20'), a chat COVERED by folder 5: rides alongside.
      chatOverrides: [{ peer: userRef('alice'), verbs: ['send'] }],
    });
    const projected = roundTrip({ groupVerbs: ['read'], scope: mixed });

    expect(projected.folders).toEqual([{ kind: 'id', id: 5 }]);
    // Covered chats ('10','20') are de-duped out; only the two individual picks remain.
    expect(projected.chats).toEqual([ME, idRef('-1001234')]);
    // The hand-authored write-only override ('send') collapses to the full write tier.
    expect(projected.chatOverrides).toEqual([
      { peer: userRef('alice'), verbs: W_TIER },
    ]);
    expect(projected.groupVerbs).toEqual(R_TIER);
  });
});

describe('re-hydrate pre-checks FOLDERS and CHATS', () => {
  it('pre-marks folderScope, pre-checks folder-member + individual chats, and pre-sets overrides', () => {
    const model = hydratePickerSelection({
      groupVerbs: ['read'],
      scope: scope({
        chats: [ME, idRef('-1001234')],
        folders: [{ kind: 'id', id: 5 }],
        chatOverrides: [{ peer: userRef('alice'), verbs: ['send'] }],
      }),
      enumeration,
    });

    // Folder scope pre-marked by id key (folder 5 only, NOT folder 8).
    expect([...(model.folderScope ?? [])]).toEqual(['5']);

    // Folder-member chats pre-checked; the covered '20' also carries its override.
    expect(model.selection.get('10')).toEqual({ read: true, write: false }); // group verbs made explicit
    expect(model.selection.get('20')).toEqual({ read: false, write: true }); // declared override

    // Individually listed chats pre-checked too (explicit group bits).
    expect(model.selection.get('me')).toEqual({ read: true, write: false });
    expect(model.selection.get('-1001234')).toEqual({ read: true, write: false });
  });

  it('is fail-closed for an unresolvable folder ref (default-deny, no phantom scope)', () => {
    const model = hydratePickerSelection({
      groupVerbs: ['read'],
      scope: scope({ folders: [{ kind: 'id', id: 999 }] }), // no such folder enumerated
      enumeration,
    });
    expect([...(model.folderScope ?? [])]).toEqual([]);
    expect(model.selection.size).toBe(0);
  });
});
