/**
 * Pure picker reducer — the load-bearing rules pinned here (the whole point of
 * the framework-free core), under the MEMBERSHIP-IS-ACCESS model (no inherit
 * layer, no group default — every member carries explicit bits):
 *   - id-keyed dedup across folders (a multi-folder chat is ONE selection entry)
 *   - r/w pick-up grants read (fresh r -> r, fresh w -> rw; write-only reachable)
 *   - r/w on the folder-unit row SET the whole folder (and track folderScope)
 *   - r/w with a visual range SET the range (vim-style: the op consumes it)
 *   - search-preserves-selection (id-keyed accumulation; clearing restores marks)
 *   - tri-state derivation (bottom-up over ALL children, never stored)
 *   - r/w GRANT actions inert while the search box is focused
 */
import { describe, it, expect } from 'vitest';
import {
  createPickerState,
  pickerReducer,
  resolveEffective,
  deriveFolderTriState,
  selectFolderCounts,
  selectVisibleRows,
  selectShownCounts,
  selectTabs,
  selectWindow,
  type AccessBits,
  type ChatKey,
  type ChatRow,
  type FolderRow,
  type PickerAction,
  type PickerState,
  type Row,
} from '../../src/presentation/cli/picker/index.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const folder = (
  id: string,
  title: string,
  childChatKeys: readonly ChatKey[],
  depth = 0,
): FolderRow => ({ kind: 'folder', id, depth, title, childChatKeys });

const chat = (
  id: string,
  chatKey: ChatKey,
  title: string,
  opts: { depth?: number; username?: string; folderTitles?: readonly string[] } = {},
): ChatRow => ({
  kind: 'chat',
  id,
  depth: opts.depth ?? 1,
  chatKey,
  title,
  chatKind: 'channel',
  ...(opts.username !== undefined ? { username: opts.username } : {}),
  folderTitles: opts.folderTitles ?? [],
});

/**
 * A small tree exercising every shape that matters:
 *   Work     -> eng, rel, rnd
 *   Clients  -> acme*, beta            (* = also under Vendors)
 *   Vendors  -> acme*, vend
 * `acme` appears under TWO folders with the SAME chatKey (multi-folder dedup).
 */
const buildRows = (): Row[] => [
  folder('f-work', 'Work', ['eng', 'rel', 'rnd']),
  chat('r-eng', 'eng', 'eng-standup'),
  chat('r-rel', 'rel', 'releases', { username: 'rel_chan' }),
  chat('r-rnd', 'rnd', 'random'),
  folder('f-clients', 'Clients', ['acme', 'beta']),
  chat('r-acme-c', 'acme', 'Acme Corp', { folderTitles: ['Clients', 'Vendors'] }),
  chat('r-beta', 'beta', 'Beta Inc'),
  folder('f-vendors', 'Vendors', ['acme', 'vend']),
  chat('r-acme-v', 'acme', 'Acme Corp', { folderTitles: ['Clients', 'Vendors'] }),
  chat('r-vend', 'vend', 'Vendor One'),
];

const baseState = (over: Partial<PickerState> = {}): PickerState => ({
  ...createPickerState({ endpointName: 'support-reader', rows: buildRows() }),
  ...over,
});

const run = (state: PickerState, ...actions: readonly PickerAction[]): PickerState =>
  actions.reduce(pickerReducer, state);

/** Park the cursor on a row (production moves the cursor via `move` up/down). */
const at = (state: PickerState, rowId: string): PickerState => ({
  ...state,
  cursorRowId: rowId,
});

/** Switch the active tab (production steps through the strip via next/prevTab). */
const onTab = (state: PickerState, tabKey: string): PickerState => ({
  ...state,
  activeTabKey: tabKey,
});

const RW = (read: boolean, write: boolean): AccessBits => ({ read, write });

/** `r`/`w` on the row with this id (park the cursor, then toggle). */
const press = (state: PickerState, rowId: string, axis: 'read' | 'write'): PickerState =>
  run(at(state, rowId), { type: 'toggleBit', axis });

// ---------------------------------------------------------------------------
// Factory + immutability
// ---------------------------------------------------------------------------

describe('createPickerState', () => {
  it('opens on the All tab with the cursor on its first chat and NOTHING in scope', () => {
    const s = baseState();
    expect(s.activeTabKey).toBe('all');
    expect(s.cursorRowId).toBe('r-eng'); // All tab has no folder rows
    expect(s.selection.size).toBe(0); // default-deny
    expect(s.folderScope.size).toBe(0);
  });

  it('cursor is undefined for an empty tree', () => {
    const s = createPickerState({ endpointName: 'x', rows: [] });
    expect(s.cursorRowId).toBeUndefined();
  });
});

describe('immutability', () => {
  it('never mutates the input state or its selection map', () => {
    const s = baseState();
    const frozenSelection = s.selection;
    const next = press(s, 'r-eng', 'read');
    expect(next).not.toBe(s);
    expect(s.selection).toBe(frozenSelection);
    expect(s.selection.size).toBe(0);
    expect(next.selection.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// id-keyed dedup across folders
// ---------------------------------------------------------------------------

describe('id-keyed dedup across folders', () => {
  it('granting via one of two rows that share a chatKey grants BOTH (one entry)', () => {
    const s = press(baseState(), 'r-acme-c', 'read');
    expect(s.selection.size).toBe(1);
    expect(resolveEffective(s, 'acme').member).toBe(true);
    // The Vendors copy resolves identically — same chatKey, same entry.
    expect(resolveEffective(s, 'acme').bits).toEqual(RW(true, false));
  });

  it('write granted via one folder is visible from the other folder', () => {
    const s = press(baseState(), 'r-acme-v', 'write');
    expect(resolveEffective(s, 'acme').bits).toEqual(RW(true, true));
  });
});

// ---------------------------------------------------------------------------
// cursor orthogonality
// ---------------------------------------------------------------------------

describe('cursor / access orthogonality', () => {
  it('move only touches the cursor, never selection', () => {
    const s = run(baseState(), { type: 'move', direction: 'down' });
    expect(s.cursorRowId).toBe('r-rel');
    expect(s.selection.size).toBe(0);
  });

  it('move clamps at the ends of the visible list', () => {
    const s = run(baseState(), { type: 'move', direction: 'up' });
    expect(s.cursorRowId).toBe('r-eng'); // already at the top
  });
});

// ---------------------------------------------------------------------------
// tabs + windowing (unchanged by the access model)
// ---------------------------------------------------------------------------

describe('tab navigation', () => {
  it('the All tab lists every chat once (deduped), with NO folder rows', () => {
    const vis = selectVisibleRows(baseState());
    expect(vis.every((r) => r.kind === 'chat')).toBe(true);
    expect(vis.map((r) => (r.kind === 'chat' ? r.chatKey : ''))).toEqual([
      'eng',
      'rel',
      'rnd',
      'acme',
      'beta',
      'vend',
    ]);
  });

  it('selectTabs yields All + one tab per folder in order', () => {
    const tabs = selectTabs(baseState());
    expect(tabs.map((t) => t.title)).toEqual([
      'All chats',
      'Work',
      'Clients',
      'Vendors',
    ]);
  });

  it('a folder tab shows its unit row first, then that folder’s chats', () => {
    const s = onTab(baseState(), 'f-work');
    const vis = selectVisibleRows(s);
    expect(vis[0]?.id).toBe('f-work');
    expect(vis.slice(1).map((r) => r.id)).toEqual(['r-eng', 'r-rel', 'r-rnd']);
  });

  it('nextTab / prevTab step through the strip and clamp at the ends', () => {
    let s = run(baseState(), { type: 'nextTab' });
    expect(s.activeTabKey).toBe('f-work');
    s = run(s, { type: 'prevTab' }, { type: 'prevTab' });
    expect(s.activeTabKey).toBe('all'); // clamped
  });
});

describe('viewport windowing (list-only scroll)', () => {
  it('windows the active tab to viewportRows and reports hidden above/below', () => {
    const s = run(baseState(), { type: 'setViewportRows', rows: 2 });
    const w = selectWindow(s);
    expect(w.rows.length).toBe(2);
    expect(w.total).toBe(6);
    expect(w.above + w.rows.length + w.below).toBe(w.total);
  });

  it('keeps the cursor inside the window as it moves down', () => {
    let s = run(baseState(), { type: 'setViewportRows', rows: 2 });
    for (let i = 0; i < 4; i += 1) s = run(s, { type: 'move', direction: 'down' });
    const w = selectWindow(s);
    expect(w.rows.some((r) => r.id === s.cursorRowId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toggleBit — the ONE grant key (r/w)
// ---------------------------------------------------------------------------

describe('toggleBit on a chat (fresh r -> r, fresh w -> rw, unpick on last bit)', () => {
  it('fresh r -> read-only, fresh w -> read+write (write implies read on pick-up)', () => {
    let s = at(baseState(), 'r-eng');
    expect(resolveEffective(s, 'eng').member).toBe(false);
    // `r` picks it up READ-ONLY.
    s = pickerReducer(s, { type: 'toggleBit', axis: 'read' });
    expect(resolveEffective(s, 'eng').bits).toEqual(RW(true, false));
    // `r` again -> no access -> UNPICKED (membership follows access).
    s = pickerReducer(s, { type: 'toggleBit', axis: 'read' });
    expect(resolveEffective(s, 'eng').member).toBe(false);
    expect(s.selection.has('eng')).toBe(false); // entry fully removed
    // `w` on a fresh chat grants READ+WRITE (the common intent).
    s = pickerReducer(s, { type: 'toggleBit', axis: 'write' });
    expect(resolveEffective(s, 'eng').bits).toEqual(RW(true, true));
  });

  it('on a MEMBER, toggleBit flips ONE axis and leaves the other untouched', () => {
    let s = press(baseState(), 'r-eng', 'write'); // rw
    s = pickerReducer(s, { type: 'toggleBit', axis: 'write' }); // w off (r untouched)
    expect(resolveEffective(s, 'eng').bits).toEqual(RW(true, false));
    s = pickerReducer(s, { type: 'toggleBit', axis: 'write' }); // w on again
    expect(resolveEffective(s, 'eng').bits).toEqual(RW(true, true));
  });

  it('WRITE-ONLY (send-only) is still reachable by dropping read from rw', () => {
    let s = press(baseState(), 'r-eng', 'write'); // rw
    s = pickerReducer(s, { type: 'toggleBit', axis: 'read' }); // drop read
    expect(resolveEffective(s, 'eng').member).toBe(true);
    expect(resolveEffective(s, 'eng').bits).toEqual(RW(false, true));
  });

  it('is INERT while the search box is focused (typing never grants)', () => {
    let s = run(baseState(), { type: 'setFocus', focus: 'search' });
    s = pickerReducer(s, { type: 'toggleBit', axis: 'write' });
    expect(s.selection.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// r/w on the folder-unit row — whole-folder access + folderScope tracking
// ---------------------------------------------------------------------------

describe('r/w on the folder-unit row (group management)', () => {
  const onWorkFolder = (): PickerState =>
    at(onTab(baseState(), 'f-work'), 'f-work');

  it('the folder toggles like ONE BIG CHAT: fresh w -> rw, w again -> r, r -> deselected', () => {
    // Fresh folder + `w` -> every chat read+write (picked up).
    let s = pickerReducer(onWorkFolder(), { type: 'toggleBit', axis: 'write' });
    for (const k of ['eng', 'rel', 'rnd']) {
      expect(resolveEffective(s, k).member).toBe(true);
      expect(resolveEffective(s, k).bits).toEqual(RW(true, true));
    }
    // A chat in ANOTHER folder is unaffected.
    expect(resolveEffective(s, 'beta').member).toBe(false);
    // Uniform rw + `w` -> write drops off (read-only), exactly like a chat row.
    s = pickerReducer(s, { type: 'toggleBit', axis: 'write' });
    for (const k of ['eng', 'rel', 'rnd']) {
      expect(resolveEffective(s, k).bits).toEqual(RW(true, false));
    }
    // Uniform read-only + `r` -> last bit clears -> the WHOLE folder deselects.
    s = pickerReducer(s, { type: 'toggleBit', axis: 'read' });
    for (const k of ['eng', 'rel', 'rnd']) {
      expect(resolveEffective(s, k).member).toBe(false);
    }
    expect(s.selection.size).toBe(0);
  });

  it('`r` on an already read-only folder DESELECTS it (the toggle-off)', () => {
    let s = pickerReducer(onWorkFolder(), { type: 'toggleBit', axis: 'read' });
    for (const k of ['eng', 'rel', 'rnd']) {
      expect(resolveEffective(s, k).bits).toEqual(RW(true, false));
    }
    s = pickerReducer(s, { type: 'toggleBit', axis: 'read' });
    expect(s.selection.size).toBe(0);
  });

  it('overwrites a divergent per-chat grant (SET semantics, WYSIWYG)', () => {
    let s = press(baseState(), 'r-rel', 'write'); // rel is rw
    s = at(onTab(s, 'f-work'), 'f-work');
    s = pickerReducer(s, { type: 'toggleBit', axis: 'read' }); // whole folder read-only
    expect(resolveEffective(s, 'rel').bits).toEqual(RW(true, false));
  });

  it('a multi-folder chat set via EITHER folder stays ONE selection entry', () => {
    let s = run(at(onTab(baseState(), 'f-clients'), 'f-clients'), {
      type: 'toggleBit',
      axis: 'write',
    });
    s = run(at(onTab(s, 'f-vendors'), 'f-vendors'), {
      type: 'toggleBit',
      axis: 'read',
    });
    // Vendors' SET wins for the shared chat; still exactly one entry.
    expect(resolveEffective(s, 'acme').bits).toEqual(RW(true, false));
    expect([...s.selection.keys()].filter((k) => k === 'acme')).toHaveLength(1);
  });
});

describe('folderScope (folder-as-scope-unit tracking)', () => {
  const scopedRows = (): Row[] => [
    { ...folder('f', 'Keyed', ['c1', 'c2']), folderKey: '42' },
    chat('r-c1', 'c1', 'One'),
    chat('r-c2', 'c2', 'Two'),
  ];
  const scopedState = (): PickerState =>
    createPickerState({ endpointName: 'e', rows: scopedRows() });

  it('r/w on a keyed folder row marks it a scope unit', () => {
    const s = run(at(scopedState(), 'f'), { type: 'toggleBit', axis: 'read' });
    expect(s.folderScope.has('42')).toBe(true);
  });

  it('toggling the folder OFF (r on read-only) clears the scope-unit mark too', () => {
    let s = run(at(scopedState(), 'f'), { type: 'toggleBit', axis: 'read' });
    s = pickerReducer(s, { type: 'toggleBit', axis: 'read' }); // uniform r -> off
    expect(s.selection.size).toBe(0);
    expect(s.folderScope.size).toBe(0);
  });

  it('clearAccess on the folder row unpicks its chats AND clears the unit mark', () => {
    let s = run(at(scopedState(), 'f'), { type: 'toggleBit', axis: 'write' });
    s = pickerReducer(s, { type: 'clearAccess' });
    expect(s.folderScope.size).toBe(0);
    expect(s.selection.size).toBe(0);
  });

  it('a folder row with no folderKey grants access but is NOT tracked as a unit', () => {
    const s = run(at(onTab(baseState(), 'f-work'), 'f-work'), {
      type: 'toggleBit',
      axis: 'read',
    });
    expect(resolveEffective(s, 'eng').member).toBe(true);
    expect(s.folderScope.size).toBe(0);
  });

  it('r/w on an unmarked EMPTY folder is a NO-OP — never an invisible scope-unit mark', () => {
    // Silently adding a childless folder to folderScope would commit a folders[]
    // ref that widens the ACL later, when the folder gains chats. The reducer
    // must refuse to CREATE that state.
    const rows: Row[] = [
      { ...folder('f-empty', 'Empty', []), folderKey: '7' },
      chat('r-c1', 'c1', 'One', { depth: 0 }),
    ];
    const s0 = createPickerState({ endpointName: 'e', rows });
    let s = run(at(s0, 'f-empty'), { type: 'toggleBit', axis: 'read' });
    expect(s.folderScope.size).toBe(0);
    expect(s.selection.size).toBe(0);
    s = pickerReducer(s, { type: 'toggleBit', axis: 'write' });
    expect(s.folderScope.size).toBe(0);
    expect(s.selection.size).toBe(0);
  });

  it('a hydrate-authored empty-folder mark is VISIBLE (full) and r toggles it OFF', () => {
    // Config-authored folders[] refs whose live membership is empty at edit time
    // arrive via createPickerState's folderScope input. They must render as a
    // selected scope unit (never an invisible commit) and be removable in place.
    const emptyFolder: FolderRow = { ...folder('f-empty', 'Empty', []), folderKey: '7' };
    const rows: Row[] = [emptyFolder, chat('r-c1', 'c1', 'One', { depth: 0 })];
    const s0 = createPickerState({
      endpointName: 'e',
      rows,
      folderScope: new Set(['7']),
    });
    expect(deriveFolderTriState(s0, emptyFolder)).toBe('full');

    const s = run(at(s0, 'f-empty'), { type: 'toggleBit', axis: 'read' });
    expect(s.folderScope.size).toBe(0); // r removes the mark (a visible cue exists)
    expect(deriveFolderTriState(s, emptyFolder)).toBe('none');
  });

  it('a hydrate-authored empty-folder mark is also removable via Backspace', () => {
    const rows: Row[] = [
      { ...folder('f-empty', 'Empty', []), folderKey: '7' },
      chat('r-c1', 'c1', 'One', { depth: 0 }),
    ];
    const s0 = createPickerState({
      endpointName: 'e',
      rows,
      folderScope: new Set(['7']),
    });
    const s = run(at(s0, 'f-empty'), { type: 'clearAccess' });
    expect(s.folderScope.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// clearAccess (0/Backspace)
// ---------------------------------------------------------------------------

describe('clearAccess (remove from scope)', () => {
  it('on a member chat: drops the selection entry entirely', () => {
    let s = press(baseState(), 'r-eng', 'write');
    s = pickerReducer(s, { type: 'clearAccess' });
    expect(s.selection.has('eng')).toBe(false);
    expect(resolveEffective(s, 'eng').member).toBe(false);
  });

  it('on a non-member chat: no-op (state identity preserved)', () => {
    const s = at(baseState(), 'r-eng');
    expect(pickerReducer(s, { type: 'clearAccess' })).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// tri-state + folder counts (derived)
// ---------------------------------------------------------------------------

describe('tri-state derivation', () => {
  const work = (): FolderRow => folder('f-work', 'Work', ['eng', 'rel', 'rnd']);

  it('none when no child is a member', () => {
    expect(deriveFolderTriState(baseState(), work())).toBe('none');
  });

  it('partial when some children are members', () => {
    const s = press(baseState(), 'r-eng', 'read');
    expect(deriveFolderTriState(s, work())).toBe('partial');
  });

  it('full when every child is a member', () => {
    let s = baseState();
    for (const id of ['r-eng', 'r-rel', 'r-rnd']) s = press(s, id, 'read');
    expect(deriveFolderTriState(s, work())).toBe('full');
  });

  it('folder counts report members / total / writable', () => {
    let s = press(baseState(), 'r-eng', 'read');
    s = press(s, 'r-rel', 'write');
    expect(selectFolderCounts(s, work())).toEqual({
      members: 2,
      total: 3,
      writable: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// visual range + bulk helpers
// ---------------------------------------------------------------------------

describe('visual range + r/w (SET over the range, then the range collapses)', () => {
  it('v .. move .. w sets read+write on every chat in the range', () => {
    let s = run(
      at(baseState(), 'r-eng'),
      { type: 'beginVisualRange' },
      { type: 'move', direction: 'down' }, // rel
      { type: 'move', direction: 'down' }, // rnd
    );
    s = pickerReducer(s, { type: 'toggleBit', axis: 'write' });
    for (const k of ['eng', 'rel', 'rnd']) {
      expect(resolveEffective(s, k).bits).toEqual(RW(true, true));
    }
    expect(resolveEffective(s, 'acme').member).toBe(false); // outside the range
    expect(s.visualAnchorRowId).toBeUndefined(); // consumed
  });

  it('r over a range SETS read-only (overwrites divergent bits)', () => {
    let s = press(baseState(), 'r-rel', 'write'); // rel = rw
    s = run(
      at(s, 'r-eng'),
      { type: 'beginVisualRange' },
      { type: 'move', direction: 'down' }, // rel
    );
    s = pickerReducer(s, { type: 'toggleBit', axis: 'read' });
    expect(resolveEffective(s, 'eng').bits).toEqual(RW(true, false));
    expect(resolveEffective(s, 'rel').bits).toEqual(RW(true, false));
  });

  it('beginVisualRange anchors the range on the cursor row', () => {
    const s = run(baseState(), { type: 'beginVisualRange' });
    expect(s.visualAnchorRowId).toBe('r-eng');
  });
});

describe('shown-scoped bulk helpers', () => {
  it('selectAllShown picks the ACTIVE tab’s chats read-only; existing bits stay', () => {
    let s = press(baseState(), 'r-rel', 'write'); // rel already rw
    s = run(onTab(s, 'f-work'), { type: 'selectAllShown' });
    expect(resolveEffective(s, 'eng').bits).toEqual(RW(true, false)); // new: read-only
    expect(resolveEffective(s, 'rel').bits).toEqual(RW(true, true)); // kept
    expect(resolveEffective(s, 'beta').member).toBe(false); // other tab untouched
  });

  it('selectAllShown is scoped to the FILTER when one is active', () => {
    const s = run(baseState(), { type: 'setFilter', query: 'eng' }, {
      type: 'selectAllShown',
    });
    expect(resolveEffective(s, 'eng').member).toBe(true);
    expect(resolveEffective(s, 'rel').member).toBe(false);
  });

  it('invertShown drops members and picks non-members read-only', () => {
    let s = press(baseState(), 'r-eng', 'write'); // eng in scope (rw)
    s = run(onTab(s, 'f-work'), { type: 'invertShown' });
    expect(resolveEffective(s, 'eng').member).toBe(false);
    expect(resolveEffective(s, 'rel').bits).toEqual(RW(true, false));
    expect(resolveEffective(s, 'rnd').bits).toEqual(RW(true, false));
  });
});

// ---------------------------------------------------------------------------
// search / filter
// ---------------------------------------------------------------------------

describe('search preserves selection (id-keyed accumulation)', () => {
  it('filtering hides non-matches but keeps their marks; clearing restores them', () => {
    let s = press(baseState(), 'r-eng', 'read');
    s = run(s, { type: 'setFilter', query: 'acme' });
    expect(selectVisibleRows(s).some((r) => r.id === 'r-eng')).toBe(false);
    expect(resolveEffective(s, 'eng').member).toBe(true); // mark survives
    s = run(s, { type: 'clearFilter' });
    expect(selectVisibleRows(s).some((r) => r.id === 'r-eng')).toBe(true);
  });

  it('filter matches by username as well as title', () => {
    const s = run(baseState(), { type: 'setFilter', query: 'rel_chan' });
    expect(selectVisibleRows(s).map((r) => r.id)).toEqual(['r-rel']);
  });

  it('shown counts are by unique chat id (multi-folder counts once)', () => {
    const counts = selectShownCounts(baseState());
    expect(counts).toEqual({ shown: 6, total: 6 });
  });

  it('fuzzy filter matches a NON-CONTIGUOUS subsequence, not just a substring', () => {
    const s = run(baseState(), { type: 'setFilter', query: 'egsp' }); // eng-standup
    expect(selectVisibleRows(s).map((r) => r.id)).toEqual(['r-eng']);
  });

  it('searchNext wraps forward over shown chat rows', () => {
    let s = run(baseState(), { type: 'searchNext' });
    expect(s.cursorRowId).toBe('r-rel'); // from eng
    for (let i = 0; i < 5; i += 1) s = run(s, { type: 'searchNext' });
    expect(s.cursorRowId).toBe('r-eng'); // 6 chats: wrapped fully around
  });
});

// ---------------------------------------------------------------------------
// resolveEffective (thin projection of the explicit selection)
// ---------------------------------------------------------------------------

describe('resolveEffective', () => {
  it('non-member resolves to excluded with no access', () => {
    const eff = resolveEffective(baseState(), 'eng');
    expect(eff.member).toBe(false);
    expect(eff.bits).toEqual(RW(false, false));
  });

  it('a member resolves to exactly its explicit bits (WYSIWYG)', () => {
    const s = press(baseState(), 'r-eng', 'write');
    expect(resolveEffective(s, 'eng')).toEqual({
      member: true,
      bits: RW(true, true),
    });
  });
});
