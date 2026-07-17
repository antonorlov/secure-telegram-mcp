/**
 * Picker bridge — building the flat picker tree + enumeration from the live
 * setup-client dialogs, and the chat-ref form helpers used for round-tripping.
 */
import { describe, it, expect } from 'vitest';

import {
  buildPickerTree,
  chatMatchesFolderFlags,
} from '../../src/presentation/cli/picker-bridge.js';
import {
  createPickerState,
  pickerReducer,
  deriveFolderTriState,
  selectVisibleRows,
  type AccessBits,
  type ChatKey,
  type ChatRow,
  type FolderRow,
  type PickerState,
} from '../../src/presentation/cli/picker/index.js';
import { chatEntryToRef, parseChatRef } from '../../src/config/index.js';
import { ChatId, PeerRefFactory } from '../../src/domain/index.js';
import { isErr, unwrap } from '../../src/shared/result.js';
import type {
  AccountChatDto as SetupChat,
  AccountFolderDto as SetupFolder,
} from '../../src/application/index.js';

const chats: readonly SetupChat[] = [
  { id: '-100123', title: 'Team', kind: 'group' },
  { id: '777', title: 'News', kind: 'channel', username: 'newschan' },
  { id: '5', title: 'Ada', kind: 'user' },
];

const ALL_FLAGS = {
  contacts: false,
  nonContacts: false,
  groups: false,
  broadcasts: false,
  bots: false,
  excludeMuted: false,
  excludeRead: false,
  excludeArchived: false,
} as const;

describe('folder RULE evaluation (matches the official clients)', () => {
  it('type flags select by chat type/contact-status (Contacts folder)', () => {
    const contact: SetupChat = { id: '1', title: 'A', kind: 'user', isContact: true };
    const nonContact: SetupChat = { id: '2', title: 'B', kind: 'user', isContact: false };
    const bot: SetupChat = { id: '3', title: 'Bot', kind: 'bot' };
    const group: SetupChat = { id: '-100', title: 'G', kind: 'supergroup' };
    const flags = { ...ALL_FLAGS, contacts: true };
    expect(chatMatchesFolderFlags(contact, flags)).toBe(true);
    expect(chatMatchesFolderFlags(nonContact, flags)).toBe(false);
    expect(chatMatchesFolderFlags(bot, flags)).toBe(false);
    expect(chatMatchesFolderFlags(group, flags)).toBe(false);
  });

  it('exclude_muted drops muted chats unless they have an unread mention', () => {
    const flags = { ...ALL_FLAGS, groups: true, excludeMuted: true };
    const muted: SetupChat = { id: '-1', title: 'M', kind: 'group', isMuted: true };
    const mutedMention: SetupChat = { id: '-2', title: 'M2', kind: 'group', isMuted: true, hasUnreadMention: true };
    expect(chatMatchesFolderFlags(muted, flags)).toBe(false);
    expect(chatMatchesFolderFlags(mutedMention, flags)).toBe(true);
  });

  it('a "Personal" (Contacts) folder expands to the contact chats in the tree', () => {
    const roster: readonly SetupChat[] = [
      { id: '1', title: 'Alice', kind: 'user', isContact: true },
      { id: '2', title: 'Bob', kind: 'user', isContact: true },
      { id: '3', title: 'Stranger', kind: 'user', isContact: false },
      { id: '-100', title: 'Group', kind: 'supergroup' },
    ];
    const personal: SetupFolder = {
      id: 7,
      title: 'Personal',
      chatIds: [], // no explicitly-pinned chats — pure rule folder
      flags: { ...ALL_FLAGS, contacts: true },
    };
    const { rows } = buildPickerTree(roster, [personal]);
    const folder = rows.find((r) => r.kind === 'folder');
    expect(folder?.kind === 'folder' && folder.childChatKeys).toEqual(['1', '2']);
  });

  it('separates EXPLICIT (pinned ∪ included) members from rule-matched ones', () => {
    // The runtime resolver tracks only explicit members; the bridge must mark
    // which children are which so a `folders[]` unit covers the explicit set and
    // rule matches snapshot as individual chats.
    const roster: readonly SetupChat[] = [
      { id: '1', title: 'Alice', kind: 'user', isContact: true }, // rule (contacts)
      { id: '2', title: 'Bob', kind: 'user', isContact: true }, // rule + also pinned
      { id: '-100', title: 'Pinned Group', kind: 'supergroup' }, // explicit only
    ];
    const mixed: SetupFolder = {
      id: 8,
      title: 'Mixed',
      chatIds: ['-100', '2'], // explicit: a group + one contact also matched by rule
      flags: { ...ALL_FLAGS, contacts: true }, // rule: all contacts (1, 2)
    };
    const { enumeration } = buildPickerTree(roster, [mixed]);
    const folder = enumeration.folders[0];
    expect(folder?.childChatKeys).toEqual(['-100', '2', '1']); // explicit first, then rule
    expect(folder?.explicitChatKeys).toEqual(['-100', '2']); // only pinned ∪ included
  });

  it('a PURE rule-based folder has NO explicit members', () => {
    const roster: readonly SetupChat[] = [
      { id: '1', title: 'Alice', kind: 'user', isContact: true },
      { id: '2', title: 'Bob', kind: 'user', isContact: true },
    ];
    const personal: SetupFolder = {
      id: 7,
      title: 'Personal',
      chatIds: [],
      flags: { ...ALL_FLAGS, contacts: true },
    };
    const { enumeration } = buildPickerTree(roster, [personal]);
    const folder = enumeration.folders[0];
    expect(folder?.childChatKeys).toEqual(['1', '2']);
    expect(folder?.explicitChatKeys).toEqual([]); // resolves to 0 peers at runtime
  });
});

describe('buildPickerTree', () => {
  it('prepends the self (me) chat and maps every dialog to one keyed chat row', () => {
    const { rows, enumeration } = buildPickerTree(chats);
    const chatRows = rows.filter((r) => r.kind === 'chat');
    expect(chatRows).toHaveLength(4); // me + 3 dialogs
    expect(chatRows[0]).toMatchObject({ chatKey: 'me', chatKind: 'self' });
    // Kind mapping: channel/group/user; username carried through.
    expect(chatRows.find((r) => r.chatKey === '777')).toMatchObject({
      chatKind: 'channel',
      username: 'newschan',
    });
    expect(chatRows.find((r) => r.chatKey === '-100123')).toMatchObject({
      chatKind: 'group',
    });
    // The enumeration mirrors the rows (one source per chat) for the mapper.
    expect(enumeration.chats).toHaveLength(4);
    expect(enumeration.chats[0]).toMatchObject({ chatKey: 'me', ref: { kind: 'me' } });
    expect(enumeration.folders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Folder -> chat hierarchy
// ---------------------------------------------------------------------------

const hierChats: readonly SetupChat[] = [
  { id: '-100', title: 'Team', kind: 'group' },
  { id: '200', title: 'Releases', kind: 'channel', username: 'rel' },
  { id: '300', title: 'Acme', kind: 'user' }, // lives under TWO folders
  { id: '400', title: 'Beta', kind: 'user' },
  { id: '500', title: 'Lonely', kind: 'user' }, // in no folder
];

const hierFolders: readonly SetupFolder[] = [
  { id: 1, title: 'Work', chatIds: ['-100', '200'] },
  { id: 2, title: 'Clients', chatIds: ['300', '400'] },
  { id: 3, title: 'Vendors', chatIds: ['300', '999'] }, // 999 is NOT enumerated
];

describe('buildPickerTree — folder -> chat hierarchy', () => {
  it('emits folders as collapsed tri-state parents with nested member chats', () => {
    const { rows } = buildPickerTree(hierChats, hierFolders);
    // self at top (flat), then each folder with its children, then orphans.
    const summary = rows.map((r) =>
      r.kind === 'folder'
        ? `F:${r.title}@${String(r.depth)}`
        : `C:${r.chatKey}@${String(r.depth)}`,
    );
    expect(summary).toEqual([
      'C:me@0',
      'F:Work@0',
      'C:-100@1',
      'C:200@1',
      'F:Clients@0',
      'C:300@1',
      'C:400@1',
      'F:Vendors@0',
      'C:300@1',
      'C:500@0', // Lonely — no folder → flat at depth 0
    ]);
  });

  it('folder rows carry only ENUMERATED members as childChatKeys', () => {
    const { rows } = buildPickerTree(hierChats, hierFolders);
    const vendors = rows.find(
      (r): r is FolderRow => r.kind === 'folder' && r.title === 'Vendors',
    );
    expect(vendors?.childChatKeys).toEqual(['300']); // '999' dropped (not enumerated)
    expect(rows.find((r) => r.id === 'folder:1')).toMatchObject({
      childChatKeys: ['-100', '200'],
    });
  });

  it('a multi-folder chat is ONE keyed entry shown under EACH folder', () => {
    const { rows, enumeration } = buildPickerTree(hierChats, hierFolders);
    const acmeRows = rows.filter((r) => r.kind === 'chat' && r.chatKey === '300');
    expect(acmeRows).toHaveLength(2); // under Clients AND Vendors
    // Distinct RowIds, ONE shared chatKey.
    expect(new Set(acmeRows.map((r) => r.id)).size).toBe(2);
    // Each row lists BOTH folder memberships (drives the "(also in: …)" note).
    for (const row of acmeRows) {
      if (row.kind === 'chat') expect(row.folderTitles).toEqual(['Clients', 'Vendors']);
    }
    // The enumeration has ONE source per real chat (deduped across folders).
    const acmeSources = enumeration.chats.filter((c) => c.chatKey === '300');
    expect(acmeSources).toHaveLength(1);
    expect(enumeration.chats).toHaveLength(6); // me + 5 dialogs (999 never enumerated)
  });

  it('projects an id-keyed folder enumeration for the mapper', () => {
    const { enumeration } = buildPickerTree(hierChats, hierFolders);
    // These fixtures are pure-explicit folders (chatIds, no rule flags), so
    // explicitChatKeys mirrors childChatKeys — every member commits as part of
    // the `folders[]` unit.
    expect(enumeration.folders).toEqual([
      { id: 1, title: 'Work', childChatKeys: ['-100', '200'], explicitChatKeys: ['-100', '200'] },
      { id: 2, title: 'Clients', childChatKeys: ['300', '400'], explicitChatKeys: ['300', '400'] },
      { id: 3, title: 'Vendors', childChatKeys: ['300'], explicitChatKeys: ['300'] },
    ]);
  });

  it('orphan (no-folder) chats and self stay flat at depth 0', () => {
    const { rows } = buildPickerTree(hierChats, hierFolders);
    const lonely = rows.find((r) => r.kind === 'chat' && r.chatKey === '500');
    expect(lonely).toMatchObject({ depth: 0, folderTitles: [] });
    expect(rows[0]).toMatchObject({ chatKey: 'me', depth: 0 });
  });
});

describe('the built hierarchy drives the pure reducer', () => {
  const built = buildPickerTree(hierChats, hierFolders);
  const state = (): PickerState =>
    createPickerState({ endpointName: 'ep', rows: built.rows });

  it('opens on the All tab with the cursor on the first chat (self), listed flat', () => {
    const s = state();
    expect(s.cursorRowId).toBe('chat:me');
    // The All tab lists chats flat (no folder rows); the self chat is first.
    const ids = selectVisibleRows(s).map((r) => r.id);
    expect(ids[0]).toBe('chat:me');
    expect(ids.some((id) => id.startsWith('folder:'))).toBe(false);
  });

  const folderById = (id: string): FolderRow =>
    built.rows.find((r) => r.id === id) as FolderRow;

  it('r-on-folder grants the whole folder as a scope unit (partial -> full)', () => {
    // The cursor is parked on the folder row; the cascade covers every child.
    const s = pickerReducer(
      { ...state(), cursorRowId: 'folder:1' },
      { type: 'toggleBit', axis: 'read' },
    );
    expect(deriveFolderTriState(s, folderById('folder:1'))).toBe('full');
    expect(s.selection.get('-100')).toEqual({ read: true, write: false });
    expect(s.selection.get('200')).toEqual({ read: true, write: false });
  });

  it('marking a multi-folder chat once marks it under BOTH folders (one entry)', () => {
    const s = pickerReducer(
      { ...state(), cursorRowId: 'chat:2:300' }, // Acme under Clients
      { type: 'toggleBit', axis: 'read' },
    );
    expect(s.selection.size).toBe(1);
    // Derived per-folder: both see Acme as a member (ONE id-keyed selection).
    expect(deriveFolderTriState(s, folderById('folder:2'))).toBe('partial');
    expect(deriveFolderTriState(s, folderById('folder:3'))).toBe('full'); // Acme only
  });
});

describe('chat-ref form helpers (the config round-trip pair)', () => {
  it('round-trips me / @user / id forms', () => {
    const idRef = PeerRefFactory.fromId(unwrap(ChatId.fromString('-100')));
    expect(chatEntryToRef(PeerRefFactory.me())).toBe('me');
    expect(chatEntryToRef(unwrap(PeerRefFactory.fromUsername('bobby')))).toBe('@bobby');
    expect(chatEntryToRef(idRef)).toBe('-100');

    expect(unwrap(parseChatRef('me'))).toEqual({ kind: 'me' });
    expect(unwrap(parseChatRef('@bobby'))).toEqual({ kind: 'username', username: 'bobby' });
    expect(unwrap(parseChatRef('-100'))).toEqual(idRef);
    expect(isErr(parseChatRef('not a ref!!'))).toBe(true);
  });
});

describe('default display order — selected-first, then last activity', () => {
  // Synthetic chats in Telegram's native (last-activity) order. English + fake ids.
  const feed: readonly SetupChat[] = [
    { id: '-1001000000001', title: 'Alpha', kind: 'channel' }, // rank 0 (most recent)
    { id: '-1001000000002', title: 'Beta', kind: 'channel' }, //  rank 1
    { id: '-1001000000003', title: 'Gamma', kind: 'channel' }, // rank 2
    { id: '-1001000000004', title: 'Delta', kind: 'channel' }, // rank 3
  ];
  // Gamma + Delta live under a folder; Alpha + Beta are ungrouped.
  const folders: SetupFolder[] = [
    { id: 9, title: 'Work', chatIds: ['-1001000000003', '-1001000000004'] },
  ];
  const bits = (read: boolean, write: boolean): AccessBits => ({ read, write });
  const allTabKeys = (state: PickerState): string[] =>
    selectVisibleRows(state)
      .filter((r): r is ChatRow => r.kind === 'chat')
      .map((r) => r.chatKey);

  it('floats a SELECTED UNGROUPED chat above UNSELECTED FOLDER members (the reported bug)', () => {
    const { rows } = buildPickerTree(feed, folders);
    // Select Beta only — an ungrouped chat that (pre-fix) sank below folder members.
    const state = createPickerState({
      endpointName: 'reader',
      rows,
      selection: new Map<ChatKey, AccessBits>([['-1001000000002', bits(true, false)]]),
    });
    expect(allTabKeys(state)).toEqual([
      'me', // Saved Messages pinned first
      '-1001000000002', // Beta — SELECTED, floats above everything else
      '-1001000000001', // then the rest by last activity: Alpha (rank 0)
      '-1001000000003', // Gamma (rank 2)
      '-1001000000004', // Delta (rank 3)
    ]);
  });

  it('leads with a whole folder-scoped selection, then ungrouped by last activity', () => {
    const { rows } = buildPickerTree(feed, folders);
    // A folder-scoped endpoint pre-checks its members (Gamma, Delta) into selection.
    const state = createPickerState({
      endpointName: 'reader',
      rows,
      selection: new Map<ChatKey, AccessBits>([
        ['-1001000000003', bits(true, false)],
        ['-1001000000004', bits(true, false)],
      ]),
    });
    expect(allTabKeys(state)).toEqual([
      'me',
      '-1001000000003', // Gamma — selected (rank 2)
      '-1001000000004', // Delta — selected (rank 3)
      '-1001000000001', // Alpha — unselected (rank 0)
      '-1001000000002', // Beta — unselected (rank 1)
    ]);
  });

  it('is pure last-activity order (self first) when nothing is selected', () => {
    const { rows } = buildPickerTree(feed, folders);
    const state = createPickerState({ endpointName: 'reader', rows });
    expect(allTabKeys(state)).toEqual([
      'me',
      '-1001000000001',
      '-1001000000002',
      '-1001000000003',
      '-1001000000004',
    ]);
  });

  it('sorts members WITHIN a folder tab (selected first) without moving the folder header', () => {
    const { rows } = buildPickerTree(feed, folders);
    // Select Delta (rank 3, the LATER member) so selected-first is observable.
    const base = createPickerState({
      endpointName: 'reader',
      rows,
      selection: new Map<ChatKey, AccessBits>([['-1001000000004', bits(true, true)]]),
    });
    const state: PickerState = { ...base, activeTabKey: '9' }; // the Work folder tab
    const seq = selectVisibleRows(state).map((r) =>
      r.kind === 'folder' ? `folder:${r.title}` : `chat:${r.chatKey}`,
    );
    expect(seq).toEqual([
      'folder:Work',
      'chat:-1001000000004', // Delta — selected member first
      'chat:-1001000000003', // Gamma — unselected
    ]);
  });
});
