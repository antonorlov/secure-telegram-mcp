/**
 * Config <-> picker MAPPER — the lossless 2-bit projection. Pins: bit<->verb
 * translation tiers, hydrate pre-checks members + pre-sets overrides, project is
 * the inverse at membership/tier level (round-trip stable), a hand-authored
 * '@username' entry matches its enumerated chat (case-insensitively) and re-emits
 * in the canonical id form — membership survives a commit, never silently dropped.
 */
import { describe, it, expect } from 'vitest';

import {
  bitsToVerbs,
  hydratePickerSelection,
  projectPickerSelection,
  unmatchedPickerRefs,
  verbsToBits,
  type HydrateInput,
  type PickerEnumeration,
} from '../../src/presentation/cli/picker/index.js';
import type { ValidatedScope } from '../../src/config/index.js';
import { ChatId, PeerRefFactory, type PeerRef } from '../../src/domain/index.js';
import { unwrap } from '../../src/shared/result.js';

// Fixture helpers — domain refs built the same way the schema transforms build them.
const idRef = (raw: string): PeerRef =>
  PeerRefFactory.fromId(unwrap(ChatId.fromString(raw)));
const userRef = (name: string): PeerRef => ({ kind: 'username', username: name });
const ME: PeerRef = { kind: 'me' };

// Mirrors the real picker bridge: every enumerated chat carries the canonical
// numeric-id ref; a public chat ADDITIONALLY exposes its username so hand-authored
// '@username' scope entries can land on it.
const enumeration: PickerEnumeration = {
  chats: [
    { chatKey: '1', ref: idRef('1'), title: 'Alpha' },
    { chatKey: 'me', ref: ME, title: 'me' },
    { chatKey: '2', ref: idRef('2'), title: 'Bob', username: 'bob' },
  ],
  folders: [],
};

const scope = (over: Partial<ValidatedScope> = {}): ValidatedScope => ({
  chats: [],
  folders: [],
  chatOverrides: [],
  ...over,
});

/** The full read tier a read-bit expands to (passive read + media egress). */
const R_TIER = ['read', 'read_media'];
/** The full write tier a write-bit expands to ("w means write"). */
const W_TIER = ['send', 'draft', 'delete', 'mark_read', 'forward', 'react'];
/** A read+write member expands to both tiers. */
const RW_TIER = [...R_TIER, ...W_TIER];

describe('bit <-> verb translation (the 2-bit projection SSOT)', () => {
  it('maps verb TIERS to read/write bits (read_media -> read; react/mark_read -> write)', () => {
    expect(verbsToBits(['read'])).toEqual({ read: true, write: false });
    expect(verbsToBits(['read_media'])).toEqual({ read: true, write: false });
    expect(verbsToBits(['send'])).toEqual({ read: false, write: true });
    expect(verbsToBits(['delete'])).toEqual({ read: false, write: true });
    // mark_read + react are write-tier now.
    expect(verbsToBits(['mark_read'])).toEqual({ read: false, write: true });
    expect(verbsToBits(['react'])).toEqual({ read: false, write: true });
    expect(verbsToBits(['read', 'delete'])).toEqual({ read: true, write: true });
    expect(verbsToBits([])).toEqual({ read: false, write: false });
  });

  it('maps each bit back to its FULL tier (read -> {read,read_media}; write -> full write tier)', () => {
    expect(bitsToVerbs({ read: true, write: false })).toEqual(R_TIER);
    expect(bitsToVerbs({ read: true, write: true })).toEqual(RW_TIER);
    expect(bitsToVerbs({ read: false, write: true })).toEqual(W_TIER);
    expect(bitsToVerbs({ read: false, write: false })).toEqual([]);
  });
});

describe('hydrate', () => {
  it('pre-checks members from scope.chats and inherits by default', () => {
    const input: HydrateInput = {
      groupVerbs: ['read'],
      scope: scope({ chats: [idRef('1'), ME] }),
      enumeration,
    };
    const model = hydratePickerSelection(input);
    expect(model.selection.get('1')).toEqual({ read: true, write: false });
    expect(model.selection.get('me')).toEqual({ read: true, write: false });
    // Non-scoped chat has no entry (default-deny).
    expect(model.selection.get('2')).toBeUndefined();
  });

  it('pre-sets per-chat overrides as override rules (bits from the override verbs)', () => {
    const model = hydratePickerSelection({
      groupVerbs: ['read'],
      scope: scope({
        chats: [idRef('1')],
        chatOverrides: [{ peer: idRef('1'), verbs: ['read', 'send'] }],
      }),
      enumeration,
    });
    expect(model.selection.get('1')).toEqual({ read: true, write: true });
  });

  it('matches a username override case-insensitively', () => {
    const model = hydratePickerSelection({
      groupVerbs: ['read'],
      scope: scope({
        chats: [userRef('BOB')],
        chatOverrides: [{ peer: userRef('Bob'), verbs: ['send'] }],
      }),
      enumeration,
    });
    expect(model.selection.get('2')).toEqual({ read: false, write: true });
  });

  it('a new (empty) endpoint hydrates to nothing-member, security read-only default', () => {
    const model = hydratePickerSelection({
      groupVerbs: ['read'],
      scope: scope(),
      enumeration,
    });
    expect(model.selection.size).toBe(0);
  });

  it("a hand-authored '@username' scope entry lands on its id-enumerated chat", () => {
    // The live bridge enumerates by numeric id only; the username identity must
    // still hydrate the member (previously it showed unchecked and was dropped).
    const model = hydratePickerSelection({
      groupVerbs: ['read'],
      scope: scope({ chats: [userRef('Bob')] }),
      enumeration,
    });
    expect(model.selection.get('2')).toEqual({ read: true, write: false });
  });

  it('canonicalizes numeric override refs before matching folder members', () => {
    const numericEnumeration: PickerEnumeration = {
      chats: [{ chatKey: '123', ref: idRef('123'), title: 'Numeric' }],
      folders: [
        {
          id: 5,
          title: 'Work',
          childChatKeys: ['123'],
          explicitChatKeys: ['123'],
        },
      ],
    };
    const model = hydratePickerSelection({
      groupVerbs: ['read', 'send'],
      scope: scope({
        folders: [{ kind: 'id', id: 5 }],
        chatOverrides: [{ peer: idRef('000123'), verbs: ['read'] }],
      }),
      enumeration: numericEnumeration,
    });

    expect(model.selection.get('123')).toEqual({ read: true, write: false });
    expect(projectPickerSelection(model, numericEnumeration)).toMatchObject({
      chats: [],
      folders: [{ kind: 'id', id: 5 }],
      chatOverrides: [],
      groupVerbs: R_TIER,
    });
  });
});

describe('project (inverse of hydrate)', () => {
  it("an '@username' member SURVIVES a commit, normalized to the canonical id form", () => {
    const projected = projectPickerSelection(
      hydratePickerSelection({
        groupVerbs: ['read'],
        scope: scope({ chats: [userRef('bob')] }),
        enumeration,
      }),
      enumeration,
    );
    expect(projected.chats).toEqual([idRef('2')]);
  });

  it('round-trips membership + tiers + chat-ref FORM + overrides', () => {
    const input: HydrateInput = {
      groupVerbs: ['read'],
      scope: scope({
        chats: [idRef('1'), ME],
        chatOverrides: [{ peer: idRef('1'), verbs: ['read', 'send'] }],
      }),
      enumeration,
    };
    const projected = projectPickerSelection(
      hydratePickerSelection(input),
      enumeration,
    );

    expect(projected.chats).toEqual([idRef('1'), ME]);
    // The rw override collapses to the FULL write+read tier; group-default is r-tier.
    expect(projected.chatOverrides).toEqual([
      { peer: idRef('1'), verbs: RW_TIER },
    ]);
    expect(projected.groupVerbs).toEqual(R_TIER);
  });

  it('COLLAPSE: a hand-stripped [read, mark_read] chat collapses to the full tiers on a picker round-trip', () => {
    // A hand-authored chat with a narrow write set (mark_read only) is detected as
    // read+write by tier, so a picker round-trip re-expands both tiers — the
    // hand-stripping is intentionally lost (the 2-bit model's documented contract).
    const model = hydratePickerSelection({
      groupVerbs: ['read'],
      scope: scope({
        chats: [idRef('1')],
        chatOverrides: [{ peer: idRef('1'), verbs: ['read', 'mark_read'] }],
      }),
      enumeration,
    });
    // Detected bits: read (from `read`) + write (from `mark_read`).
    expect(model.selection.get('1')).toEqual({ read: true, write: true });
    const projected = projectPickerSelection(model, enumeration);
    expect(projected.chatOverrides).toEqual([
      { peer: idRef('1'), verbs: RW_TIER },
    ]);
  });

  it('only members emit a chat ref; only override-ruled members emit an override', () => {
    const projected = projectPickerSelection(
      {
        selection: new Map([['1', { read: true, write: false }]]),
      },
      enumeration,
    );
    expect(projected.chats).toEqual([idRef('1')]);
    expect(projected.folders).toEqual([]);
    expect(projected.chatOverrides).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Folder-as-scope-unit round-trip (folders[] <-> folderScope) — the picker's
// single selection surface now carries FOLDERS too, projected losslessly.
// ---------------------------------------------------------------------------

const withFolders: PickerEnumeration = {
  chats: enumeration.chats,
  folders: [{ id: 5, title: 'Work', childChatKeys: ['1', '2'] }],
};

describe('folder-as-scope-unit projection', () => {
  it('hydrate pre-marks folderScope + member chats from an id-form folders[] ref', () => {
    const model = hydratePickerSelection({
      groupVerbs: ['read'],
      scope: scope({ folders: [{ kind: 'id', id: 5 }] }),
      enumeration: withFolders,
    });
    expect([...(model.folderScope ?? [])]).toEqual(['5']);
    expect(model.selection.get('1')).toEqual({ read: true, write: false });
    expect(model.selection.get('2')).toEqual({ read: true, write: false });
  });

  it('hydrate matches a title-form folders[] ref case-exactly', () => {
    const model = hydratePickerSelection({
      groupVerbs: ['read'],
      scope: scope({ folders: [{ kind: 'title', title: 'Work' }] }),
      enumeration: withFolders,
    });
    expect([...(model.folderScope ?? [])]).toEqual(['5']);
  });

  it('round-trips a scoped folder to folders[] and does NOT re-emit its chats', () => {
    const projected = projectPickerSelection(
      hydratePickerSelection({
        groupVerbs: ['read'],
        scope: scope({ folders: [{ kind: 'id', id: 5 }] }),
        enumeration: withFolders,
      }),
      withFolders,
    );
    expect(projected.folders).toEqual([{ kind: 'id', id: 5 }]);
    expect(projected.chats).toEqual([]); // both members are folder-covered
  });

  it('a folder covering some chats co-exists with an individually-picked chat', () => {
    const folders2: PickerEnumeration = {
      chats: enumeration.chats,
      folders: [{ id: 5, title: 'Work', childChatKeys: ['1'] }],
    };
    const projected = projectPickerSelection(
      {
        folderScope: new Set(['5']),
        selection: new Map([
          ['1', { read: true, write: false }],
          ['me', { read: true, write: false }],
        ]),
      },
      folders2,
    );
    expect(projected.folders).toEqual([{ kind: 'id', id: 5 }]);
    expect(projected.chats).toEqual([ME]); // '1' covered, 'me' individual
  });

  it('a scoped folder whose child was since unmarked demotes to individual chats', () => {
    const projected = projectPickerSelection(
      {
        folderScope: new Set(['5']), // stale: '2' is no longer a member
        selection: new Map([['1', { read: true, write: false }]]),
      },
      withFolders,
    );
    expect(projected.folders).toEqual([]);
    expect(projected.chats).toEqual([idRef('1')]);
  });

  it('all children individually picked (no folderScope) projects as chats, NOT a folder', () => {
    const projected = projectPickerSelection(
      {
        selection: new Map([
          ['1', { read: true, write: false }],
          ['2', { read: true, write: false }],
        ]),
      },
      withFolders,
    );
    expect(projected.folders).toEqual([]);
    expect(projected.chats).toEqual([idRef('1'), idRef('2')]);
  });

  it('an override on a folder-covered chat still emits (rides alongside folder scope)', () => {
    const projected = projectPickerSelection(
      {
        folderScope: new Set(['5']),
        selection: new Map([
          ['1', { read: true, write: true }],
          ['2', { read: true, write: false }],
        ]),
      },
      withFolders,
    );
    expect(projected.folders).toEqual([{ kind: 'id', id: 5 }]);
    expect(projected.chats).toEqual([]);
    expect(projected.chatOverrides).toEqual([
      { peer: idRef('1'), verbs: RW_TIER },
    ]);
  });
});

describe('unmatchedRefs (stale references surfaced, never silently dropped)', () => {
  it('reports chat + folder refs the live enumeration no longer matches', () => {
    const withFolder: PickerEnumeration = {
      chats: enumeration.chats,
      folders: [{ id: 5, title: 'Work', childChatKeys: ['1'], explicitChatKeys: ['1'] }],
    };
    const stale = unmatchedPickerRefs(
      scope({
        chats: [
          idRef('1'), // matches
          idRef('999'), // a chat that left
          userRef('ghost'), // a renamed username
        ],
        folders: [
          { kind: 'id', id: 5 }, // matches
          { kind: 'title', title: 'Archived' }, // a renamed folder
        ],
      }),
      withFolder,
    );
    expect(stale.chats).toEqual(['999', '@ghost']);
    expect(stale.folders).toEqual(['Archived']);
  });

  it('a fully-matching scope has NO unmatched refs (nothing to warn about)', () => {
    const stale = unmatchedPickerRefs(
      scope({ chats: [idRef('1'), userRef('bob')] }),
      enumeration,
    );
    expect(stale.chats).toEqual([]);
    expect(stale.folders).toEqual([]);
  });

  it('uses the SAME matching as hydrate: a ref hydrate skips is exactly one it reports', () => {
    const s = scope({ chats: [idRef('1'), idRef('999')] });
    const model = hydratePickerSelection({ groupVerbs: ['read'], scope: s, enumeration });
    const stale = unmatchedPickerRefs(s, enumeration);
    // '1' hydrated (a member); '999' skipped by hydrate and reported by unmatchedRefs.
    expect(model.selection.has('1')).toBe(true);
    expect(stale.chats).toEqual(['999']);
  });

  it('reports stale override refs and deduplicates refs already present in chats', () => {
    // '000999' and '999' share ChatId's canonical identity, so they dedup to one
    // stale entry rendered in the canonical decimal form.
    const stale = unmatchedPickerRefs(
      scope({
        chats: [idRef('000999')],
        chatOverrides: [
          { peer: idRef('999'), verbs: ['read'] },
          { peer: userRef('ghost'), verbs: ['read'] },
        ],
      }),
      enumeration,
    );

    expect(stale.chats).toEqual(['999', '@ghost']);
  });

  it('does not report a canonically matching numeric override as stale', () => {
    const stale = unmatchedPickerRefs(
      scope({
        chatOverrides: [{ peer: idRef('0001'), verbs: ['read'] }],
      }),
      enumeration,
    );

    expect(stale.chats).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule-based (category-flag) folder members — the runtime resolver tracks only
// EXPLICIT (pinned ∪ included) members, so a `folders[]` unit covers those and
// rule matches must SNAPSHOT as individual chats (never a phantom folder unit
// that resolves to zero peers at runtime).
// ---------------------------------------------------------------------------

// Folder 5: chat '1' is explicit (pinned/included); chat '2' is rule-matched only.
const mixedFolder: PickerEnumeration = {
  chats: enumeration.chats,
  folders: [
    { id: 5, title: 'Mixed', childChatKeys: ['1', '2'], explicitChatKeys: ['1'] },
  ],
};

// Folder 6: pure rule-based — no explicit members at all.
const ruleOnlyFolder: PickerEnumeration = {
  chats: enumeration.chats,
  folders: [
    { id: 6, title: 'Contacts', childChatKeys: ['1', '2'], explicitChatKeys: [] },
  ],
};

describe('rule-based folder membership snapshots to individual chats', () => {
  it('a mixed folder commits as a unit but SNAPSHOTS its rule-matched member as a chat', () => {
    const projected = projectPickerSelection(
      {
        folderScope: new Set(['5']),
        selection: new Map([
          ['1', { read: true, write: false }], // explicit — covered by the ref
          ['2', { read: true, write: false }], // rule-matched — must snapshot
        ]),
      },
      mixedFolder,
    );
    expect(projected.folders).toEqual([{ kind: 'id', id: 5 }]);
    // '1' is covered by the folder ref; '2' (rule) is emitted individually so it
    // is actually scoped at runtime (the resolver would never include it via 5).
    expect(projected.chats).toEqual([idRef('2')]);
  });

  it('a PURE rule-based folder NEVER commits as a unit — all members snapshot as chats', () => {
    const projected = projectPickerSelection(
      {
        folderScope: new Set(['6']), // marked, but 0 explicit members
        selection: new Map([
          ['1', { read: true, write: false }],
          ['2', { read: true, write: false }],
        ]),
      },
      ruleOnlyFolder,
    );
    // No folders[] ref (it would resolve to zero peers); everything snapshots.
    expect(projected.folders).toEqual([]);
    expect(projected.chats).toEqual([idRef('1'), idRef('2')]);
  });

  it('unselecting the EXPLICIT member demotes the unit; a rule member alone does not sustain it', () => {
    const projected = projectPickerSelection(
      {
        folderScope: new Set(['5']),
        selection: new Map([['2', { read: true, write: false }]]), // only the rule member
      },
      mixedFolder,
    );
    expect(projected.folders).toEqual([]); // explicit '1' gone -> no unit
    expect(projected.chats).toEqual([idRef('2')]);
  });

  it('hydrate pre-checks ONLY the explicit member of a mixed folder ref', () => {
    const model = hydratePickerSelection({
      groupVerbs: ['read'],
      scope: scope({ folders: [{ kind: 'id', id: 5 }] }),
      enumeration: mixedFolder,
    });
    expect([...(model.folderScope ?? [])]).toEqual(['5']);
    expect(model.selection.get('1')).toEqual({ read: true, write: false }); // explicit
    expect(model.selection.get('2')).toBeUndefined(); // rule member not auto-scoped
  });

  it('round-trip is stable: hydrate(folders[5] + chats[2]) projects back to the same', () => {
    const model = hydratePickerSelection({
      groupVerbs: ['read'],
      scope: scope({
        folders: [{ kind: 'id', id: 5 }],
        chats: [idRef('2')], // the snapshotted rule member
      }),
      enumeration: mixedFolder,
    });
    const projected = projectPickerSelection(model, mixedFolder);
    expect(projected.folders).toEqual([{ kind: 'id', id: 5 }]);
    expect(projected.chats).toEqual([idRef('2')]);
  });

  it('keeps a rule snapshot when another scoped folder covers the chat explicitly', () => {
    const projected = projectPickerSelection(
      {
        folderScope: new Set(['5', '6']),
        selection: new Map([['1', { read: true, write: false }]]),
      },
      {
        chats: enumeration.chats,
        folders: [
          {
            id: 5,
            title: 'Contacts',
            childChatKeys: ['1'],
            explicitChatKeys: [],
          },
          {
            id: 6,
            title: 'Pinned',
            childChatKeys: ['1'],
            explicitChatKeys: ['1'],
          },
        ],
      },
    );

    expect(projected.folders).toEqual([{ kind: 'id', id: 6 }]);
    expect(projected.chats).toEqual([idRef('1')]);
  });
});
