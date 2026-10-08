/**
 * Pure state machine for the access picker. The load-bearing rules live here: id-keyed dedup,
 * membership-is-access, search-preserves-selection and tri-state derivation. Framework-free, so
 * the Vitest suite pins it directly.
 */
import { ALL_TAB } from './model.js';
import type {
  AccessAxis,
  AccessBits,
  ChatKey,
  ChatRow,
  EffectiveAccess,
  FolderKey,
  FolderRow,
  PickerState,
  PickerTab,
  PickerWindow,
  Row,
  TabKey,
  TriState,
} from './model.js';

const DEFAULT_VIEWPORT_ROWS = 12;

export type MoveDirection = 'up' | 'down';

// Each intent maps to exactly one axis, so a binding can never accidentally cross axes.
// Membership actions never prompt; only the write escalation does, above the reducer.
export type PickerAction =
  | { readonly type: 'move'; readonly direction: MoveDirection }
  | { readonly type: 'nextTab' } // ->/l
  | { readonly type: 'prevTab' } // <-/h
  | { readonly type: 'setViewportRows'; readonly rows: number } // terminal size -> window height
  // --- ACCESS (membership IS access — the ONLY mutating axis besides move) ---
  | { readonly type: 'toggleBit'; readonly axis: AccessAxis } // r/w: chat = flip bit (pickup grants read); folder row = set folder; visual range = SET range
  | { readonly type: 'clearAccess' } // 0/Backspace: chat = out of scope; folder row = unscope the folder
  // --- BATCH / VISUAL ---
  | { readonly type: 'beginVisualRange' } // v
  | { readonly type: 'selectAllShown' } // a: every shown chat in scope (read-only where new)
  | { readonly type: 'invertShown' } // i: members out; non-members in read-only
  // --- SEARCH / FILTER (preserves selection: id-keyed accumulation) ---
  | { readonly type: 'setFilter'; readonly query: string }
  | { readonly type: 'clearFilter' }
  | { readonly type: 'searchNext' } // n
  | { readonly type: 'searchPrev' } // N
  | { readonly type: 'setFocus'; readonly focus: PickerState['focus'] };

const NO_ACCESS: AccessBits = Object.freeze({ read: false, write: false });
// Security-first: everything is picked up READ-ONLY unless write is asked for.
const READ_ONLY: AccessBits = Object.freeze({ read: true, write: false });
const READ_WRITE: AccessBits = Object.freeze({ read: true, write: true });

// The explicit bits `r`/`w` cascade onto a folder / visual range (SET semantics).
const axisBits = (axis: AccessAxis): AccessBits =>
  axis === 'write' ? READ_WRITE : READ_ONLY;

const isMember = (state: PickerState, key: ChatKey): boolean =>
  state.selection.has(key);

const withBits = (
  selection: ReadonlyMap<ChatKey, AccessBits>,
  key: ChatKey,
  bits: AccessBits | undefined,
): ReadonlyMap<ChatKey, AccessBits> => {
  const next = new Map(selection);
  if (bits === undefined) next.delete(key);
  else next.set(key, bits);
  return next;
};

const currentRow = (state: PickerState): Row | undefined =>
  state.cursorRowId === undefined
    ? undefined
    : state.rows.find((r) => r.id === state.cursorRowId);

const clampIndex = (i: number, len: number): number =>
  Math.max(0, Math.min(len - 1, i));

const uniq = (keys: readonly ChatKey[]): ChatKey[] => [...new Set(keys)];

export const uniqueChatKeys = (rows: readonly Row[]): readonly ChatKey[] => {
  const seen = new Set<ChatKey>();
  const out: ChatKey[] = [];
  for (const row of rows) {
    if (row.kind === 'chat' && !seen.has(row.chatKey)) {
      seen.add(row.chatKey);
      out.push(row.chatKey);
    }
  }
  return out;
};

const fuzzyMatch = (query: string, target: string): boolean => {
  const q = query.toLowerCase();
  if (q === '') return true;
  const t = target.toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j += 1) {
    if (t[j] === q[i]) i += 1;
  }
  return i === q.length;
};

const chatMatches = (query: string, row: ChatRow): boolean =>
  fuzzyMatch(query, row.title) ||
  (row.username !== undefined && fuzzyMatch(query, row.username));

const EMPTY_KEYS: ReadonlySet<ChatKey> = new Set<ChatKey>();

// Snapshot-based, not the live selection, so nothing jumps mid-session: `me` first, then the
// chats selected when the picker opened, then the rest.
const displayRank = (row: ChatRow, selected: ReadonlySet<ChatKey>): number =>
  row.chatKind === 'self' ? 0 : selected.has(row.chatKey) ? 1 : 2;

// Selected-at-open first, then Telegram's native last-activity order within each band. Stable,
// so equal ranks keep their incoming order.
const orderChats = (
  chats: readonly ChatRow[],
  selected: ReadonlySet<ChatKey>,
): ChatRow[] =>
  [...chats].sort(
    (a, b) =>
      displayRank(a, selected) - displayRank(b, selected) ||
      (a.activityRank ?? Number.MAX_SAFE_INTEGER) -
        (b.activityRank ?? Number.MAX_SAFE_INTEGER),
  );

const allTabRows = (
  rows: readonly Row[],
  selected: ReadonlySet<ChatKey>,
): Row[] => {
  const seen = new Set<ChatKey>();
  const chats: ChatRow[] = [];
  for (const r of rows) {
    if (r.kind === 'chat' && !seen.has(r.chatKey)) {
      seen.add(r.chatKey);
      chats.push(r);
    }
  }
  return orderChats(chats, selected);
};

// The folder's own "whole folder as a unit" row followed by its member chats, selected-at-open
// first. `rows` is a pre-order DFS with the folder at depth d.
const folderTabRows = (
  rows: readonly Row[],
  tabKey: TabKey,
  selected: ReadonlySet<ChatKey>,
): Row[] => {
  const i = rows.findIndex(
    (r) => r.kind === 'folder' && (r.folderKey ?? r.id) === tabKey,
  );
  const folder = i === -1 ? undefined : rows[i];
  if (folder === undefined) return [];
  const members: ChatRow[] = [];
  for (let j = i + 1; j < rows.length; j += 1) {
    const r = rows[j];
    if (r === undefined || r.depth <= folder.depth) break;
    if (r.kind === 'chat') members.push(r);
  }
  return [folder, ...orderChats(members, selected)];
};

const activeTabRows = (state: PickerState): Row[] => {
  const selected = state.orderSelectedKeys ?? EMPTY_KEYS;
  return state.activeTabKey === ALL_TAB
    ? allTabRows(state.rows, selected)
    : folderTabRows(state.rows, state.activeTabKey, selected);
};

export const selectVisibleRows = (state: PickerState): readonly Row[] => {
  const base = activeTabRows(state);
  const q = state.query.trim();
  if (q === '') return base;
  // Filter within the active tab: keep the folder-unit row (the tab's own header)
  // and any chat whose title/username matches.
  return base.filter((r) => r.kind === 'folder' || chatMatches(q, r));
};

// Rows shown vs total in the active tab, by unique chat id (a multi-folder chat counts once).
export const selectShownCounts = (
  state: PickerState,
): { readonly shown: number; readonly total: number } => {
  const total = new Set<ChatKey>();
  for (const r of activeTabRows(state)) if (r.kind === 'chat') total.add(r.chatKey);
  const shown = new Set<ChatKey>();
  for (const r of selectVisibleRows(state)) {
    if (r.kind === 'chat') shown.add(r.chatKey);
  }
  return { shown: shown.size, total: total.size };
};

export const selectTabs = (state: PickerState): readonly PickerTab[] => {
  const tabs: PickerTab[] = [];
  const allKeys = new Set<ChatKey>();
  for (const r of state.rows) if (r.kind === 'chat') allKeys.add(r.chatKey);
  let allMembers = 0;
  for (const k of allKeys) if (isMember(state, k)) allMembers += 1;
  tabs.push({
    key: ALL_TAB,
    title: 'All chats',
    members: allMembers,
    total: allKeys.size,
    isFolder: false,
  });
  for (const r of state.rows) {
    if (r.kind !== 'folder') continue;
    const keys = uniq(r.childChatKeys);
    let members = 0;
    for (const k of keys) if (isMember(state, k)) members += 1;
    // Tab identity falls back to the row id when a folder carries no `folderKey`
    // (hand-built/test rows); folder-as-scope-unit tracking still keys on folderKey.
    tabs.push({
      key: r.folderKey ?? r.id,
      title: r.title,
      members,
      total: keys.length,
      isFolder: true,
    });
  }
  return tabs;
};

/**
 * Windows the filtered rows around the cursor so it stays on-screen while the list, not the
 * whole screen, scrolls. Reports the hidden-above and hidden-below counts behind the scroll
 * indicators.
 */
export const selectWindow = (state: PickerState): PickerWindow => {
  const vis = selectVisibleRows(state);
  const total = vis.length;
  const h = Math.max(1, state.viewportRows);
  const cursorIndex =
    state.cursorRowId === undefined
      ? -1
      : vis.findIndex((r) => r.id === state.cursorRowId);
  if (total <= h) {
    return { rows: vis, top: 0, total, above: 0, below: 0, cursorIndex };
  }
  const anchor = cursorIndex < 0 ? 0 : cursorIndex;
  const top = Math.max(0, Math.min(anchor - Math.floor(h / 2), total - h));
  return {
    rows: vis.slice(top, top + h),
    top,
    total,
    above: top,
    below: total - (top + h),
    cursorIndex,
  };
};

// Precedence override > group-default > excluded, mirroring the domain's `effectiveVerbPermits`
// in bit form.
export const resolveEffective = (
  state: PickerState,
  chatKey: ChatKey,
): EffectiveAccess => {
  const bits = state.selection.get(chatKey);
  return bits === undefined
    ? { member: false, bits: NO_ACCESS }
    : { member: true, bits };
};

// Tri-state for a folder — DERIVED bottom-up over ALL `childChatKeys`.
export const deriveFolderTriState = (
  state: PickerState,
  folder: FolderRow,
): TriState => {
  const keys = uniq(folder.childChatKeys);
  if (keys.length === 0) {
    /**
     * A childless folder can still be a config-authored scope UNIT, and it must render
     * selected: an invisible mark would silently commit a `folders[]` ref that widens the ACL
     * once the folder gains chats.
     */
    return folder.folderKey !== undefined &&
      state.folderScope.has(folder.folderKey)
      ? 'full'
      : 'none';
  }
  let members = 0;
  for (const k of keys) if (isMember(state, k)) members += 1;
  if (members === 0) return 'none';
  if (members === keys.length) return 'full';
  return 'partial';
};

export const selectFolderCounts = (
  state: PickerState,
  folder: FolderRow,
): { readonly members: number; readonly total: number; readonly writable: number } => {
  const keys = uniq(folder.childChatKeys);
  let members = 0;
  let writable = 0;
  for (const k of keys) {
    const eff = resolveEffective(state, k);
    if (eff.member) {
      members += 1;
      if (eff.bits.write) writable += 1;
    }
  }
  return { members, total: keys.length, writable };
};

const moveCursor = (state: PickerState, direction: MoveDirection): PickerState => {
  const vis = selectVisibleRows(state);
  if (vis.length === 0) {
    return state.cursorRowId === undefined ? state : { ...state, cursorRowId: undefined };
  }
  const idx = vis.findIndex((r) => r.id === state.cursorRowId);
  const nextIdx =
    idx === -1
      ? direction === 'down'
        ? 0
        : vis.length - 1
      : clampIndex(idx + (direction === 'down' ? 1 : -1), vis.length);
  const target = vis[nextIdx];
  return target === undefined ? state : { ...state, cursorRowId: target.id };
};

const withClampedCursor = (state: PickerState): PickerState => {
  const vis = selectVisibleRows(state);
  if (vis.length === 0) {
    return state.cursorRowId === undefined ? state : { ...state, cursorRowId: undefined };
  }
  if (state.cursorRowId !== undefined && vis.some((r) => r.id === state.cursorRowId)) {
    return state;
  }
  const first = vis[0];
  return first === undefined ? state : { ...state, cursorRowId: first.id };
};

const cycleChat = (state: PickerState, dir: 1 | -1): PickerState => {
  const chats = selectVisibleRows(state).filter(
    (r): r is ChatRow => r.kind === 'chat',
  );
  if (chats.length === 0) return state;
  const idx = chats.findIndex((r) => r.id === state.cursorRowId);
  const start = idx === -1 ? (dir === 1 ? -1 : 0) : idx;
  const next = (start + dir + chats.length) % chats.length;
  const target = chats[next];
  return target === undefined ? state : { ...state, cursorRowId: target.id };
};

const withCursorOnFirst = (state: PickerState): PickerState => {
  const first = selectVisibleRows(state)[0];
  return { ...state, cursorRowId: first?.id, visualAnchorRowId: undefined };
};

const switchToTab = (state: PickerState, tabKey: TabKey): PickerState =>
  tabKey === state.activeTabKey
    ? state
    : withCursorOnFirst({ ...state, activeTabKey: tabKey });

const stepTab = (state: PickerState, dir: 1 | -1): PickerState => {
  const keys = selectTabs(state).map((t) => t.key);
  const idx = keys.indexOf(state.activeTabKey);
  const nextIdx = clampIndex((idx === -1 ? 0 : idx) + dir, keys.length);
  const target = keys[nextIdx];
  return target === undefined ? state : switchToTab(state, target);
};

/**
 * A NON-member is picked up with READ always granted, so `r` gives read-only and `w` gives
 * read+write — write implies read, the common "make it writable" intent. A MEMBER just flips
 * that one axis.
 */
const toggleChatBit = (state: PickerState, axis: AccessAxis): PickerState => {
  const row = currentRow(state);
  if (row?.kind !== 'chat') return state;
  const current = state.selection.get(row.chatKey);
  const bits: AccessBits =
    current === undefined
      ? // Pick-up: read is always granted; write only when `w` was pressed.
        axisBits(axis)
      : { ...current, [axis]: !current[axis] };
  const next = bits.read || bits.write ? bits : undefined;
  return { ...state, selection: withBits(state.selection, row.chatKey, next) };
};

// Defined only when the folder is FULLY in scope with uniform access — the precondition for
// treating it as one toggleable unit, since mixed folders are SET rather than flipped.
export const uniformFolderBits = (
  state: PickerState,
  folder: FolderRow,
): AccessBits | undefined => {
  const keys = uniq(folder.childChatKeys);
  if (keys.length === 0) return undefined;
  let bits: AccessBits | undefined;
  for (const k of keys) {
    const cur = state.selection.get(k);
    if (cur === undefined) return undefined; // a non-member child -> not uniform
    if (bits === undefined) bits = cur;
    else if (bits.read !== cur.read || bits.write !== cur.write) return undefined;
  }
  return bits;
};

/**
 * The folder-unit row behaves like ONE BIG CHAT: a none, partial or mixed folder is SET (`r`
 * read-only, `w` read+write on every child), while a FULL, UNIFORM folder flips that one axis
 * exactly like a chat row.
 */
const setFolderAccess = (
  state: PickerState,
  folder: FolderRow,
  axis: AccessAxis,
): PickerState => {
  if (uniq(folder.childChatKeys).length === 0) {
    if (folder.folderKey !== undefined && state.folderScope.has(folder.folderKey)) {
      const folderScope = new Set(state.folderScope);
      folderScope.delete(folder.folderKey);
      return { ...state, folderScope };
    }
    return state;
  }
  const uniform = uniformFolderBits(state, folder);
  const bits: AccessBits =
    uniform === undefined
      ? axisBits(axis)
      : { ...uniform, [axis]: !uniform[axis] };
  const next = new Map(state.selection);
  const folderScope = new Set(state.folderScope);
  if (bits.read || bits.write) {
    for (const key of uniq(folder.childChatKeys)) next.set(key, bits);
    if (folder.folderKey !== undefined) folderScope.add(folder.folderKey);
  } else {
    for (const key of uniq(folder.childChatKeys)) next.delete(key);
    if (folder.folderKey !== undefined) folderScope.delete(folder.folderKey);
  }
  return { ...state, selection: next, folderScope };
};

// A chat row drops its selection entry; the folder-unit row unpicks every child and clears the
// folder's scope-unit mark.
const clearAccess = (state: PickerState): PickerState => {
  const row = currentRow(state);
  if (row === undefined) return state;
  if (row.kind === 'chat') {
    if (!state.selection.has(row.chatKey)) return state;
    return { ...state, selection: withBits(state.selection, row.chatKey, undefined) };
  }
  const next = new Map(state.selection);
  for (const key of uniq(row.childChatKeys)) next.delete(key);
  const folderScope = new Set(state.folderScope);
  if (row.folderKey !== undefined) folderScope.delete(row.folderKey);
  return { ...state, selection: next, folderScope };
};

const shownChatKeys = (state: PickerState): ChatKey[] =>
  uniq(
    selectVisibleRows(state)
      .filter((r): r is ChatRow => r.kind === 'chat')
      .map((r) => r.chatKey),
  );

// `a` — every shown chat into scope; new pick-ups are READ-ONLY, existing bits stay.
const selectAllShown = (state: PickerState): PickerState => {
  const next = new Map(state.selection);
  for (const k of shownChatKeys(state)) {
    if (!next.has(k)) next.set(k, READ_ONLY);
  }
  return { ...state, selection: next };
};

// `i` — members drop out of scope; non-members come in READ-ONLY.
const invertShown = (state: PickerState): PickerState => {
  const next = new Map(state.selection);
  for (const k of shownChatKeys(state)) {
    if (next.has(k)) next.delete(k);
    else next.set(k, READ_ONLY);
  }
  return { ...state, selection: next };
};

const visualRangeChatKeys = (state: PickerState): ChatKey[] => {
  if (state.visualAnchorRowId === undefined) return [];
  const vis = selectVisibleRows(state);
  const a = vis.findIndex((r) => r.id === state.visualAnchorRowId);
  const b = vis.findIndex((r) => r.id === state.cursorRowId);
  if (a === -1 || b === -1) return [];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return uniq(
    vis
      .slice(lo, hi + 1)
      .filter((r): r is ChatRow => r.kind === 'chat')
      .map((r) => r.chatKey),
  );
};

// SET semantics over the whole range, then the range collapses — vim-style, the operation
// consumes the selection.
const setRangeAccess = (state: PickerState, axis: AccessAxis): PickerState => {
  const targets = visualRangeChatKeys(state);
  if (targets.length === 0) return { ...state, visualAnchorRowId: undefined };
  const bits = axisBits(axis);
  const next = new Map(state.selection);
  for (const k of targets) next.set(k, bits);
  return { ...state, selection: next, visualAnchorRowId: undefined };
};

export const pickerReducer = (
  state: PickerState,
  action: PickerAction,
): PickerState => {
  switch (action.type) {
    case 'move':
      return moveCursor(state, action.direction);

    case 'nextTab':
      return stepTab(state, 1);

    case 'prevTab':
      return stepTab(state, -1);

    case 'setViewportRows': {
      const rows = Math.max(1, Math.floor(action.rows));
      return state.viewportRows === rows ? state : { ...state, viewportRows: rows };
    }

    case 'toggleBit': {
      // r/w GRANTS are INERT while typing in the search box.
      if (state.focus === 'search') return state;
      // Visual range active -> SET the whole range. On the folder-unit row ->
      // set THAT FOLDER's access. On a chat row -> flip the chat's own bit.
      if (state.visualAnchorRowId !== undefined) {
        return setRangeAccess(state, action.axis);
      }
      const row = currentRow(state);
      if (row?.kind === 'folder') {
        return setFolderAccess(state, row, action.axis);
      }
      return toggleChatBit(state, action.axis);
    }

    case 'clearAccess':
      return clearAccess(state);

    case 'beginVisualRange':
      return state.cursorRowId === undefined
        ? state
        : { ...state, visualAnchorRowId: state.cursorRowId };

    case 'selectAllShown':
      return selectAllShown(state);

    case 'invertShown':
      return invertShown(state);

    case 'setFilter':
      // Selection is UNTOUCHED (id-keyed accumulation): filtering never drops marks.
      return withClampedCursor({ ...state, query: action.query });

    case 'clearFilter':
      return state.query === ''
        ? state
        : withClampedCursor({ ...state, query: '' });

    case 'searchNext':
      return cycleChat(state, 1);

    case 'searchPrev':
      return cycleChat(state, -1);

    case 'setFocus':
      return state.focus === action.focus ? state : { ...state, focus: action.focus };

    default: {
      // Exhaustiveness guard: a new action variant must be handled above.
      const _never: never = action;
      return _never;
    }
  }
};

// State factory (pure) — assembles a normalized initial state from a row tree. Used by
// the Ink adapter and the test suite so neither hand-builds invariants.
export interface CreatePickerStateInput {
  readonly endpointName: string;
  readonly rows: readonly Row[];
  readonly selection?: ReadonlyMap<ChatKey, AccessBits>;
  readonly folderScope?: ReadonlySet<FolderKey>;
}

export const createPickerState = (input: CreatePickerStateInput): PickerState => {
  const selection = input.selection ?? new Map<ChatKey, AccessBits>();
  // Snapshot the initially-selected chats so the default order (selected-first) is
  // STABLE for the session — toggling never makes rows jump under the cursor.
  const orderSelectedKeys = new Set<ChatKey>();
  for (const [key, bits] of selection) {
    if (bits.read || bits.write) orderSelectedKeys.add(key);
  }
  const base: PickerState = {
    endpointName: input.endpointName,
    rows: input.rows,
    selection,
    folderScope: input.folderScope ?? new Set<FolderKey>(),
    orderSelectedKeys,
    cursorRowId: undefined,
    query: '',
    focus: 'tree',
    visualAnchorRowId: undefined,
    activeTabKey: ALL_TAB,
    viewportRows: DEFAULT_VIEWPORT_ROWS,
  };
  // Land the cursor on the first row of the initial (All) tab.
  const first = selectVisibleRows(base)[0];
  return { ...base, cursorRowId: first?.id };
};
