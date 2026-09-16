// Pure, immutable state shapes of the pruned-tree access picker; behaviour lives in
// `reducer.ts`. Framework-free: no Ink, React or node:*.

// The chat's canonical id key when known; a chat enumerated by the account snapshot already
// carries its marked id string.
export type ChatKey = string;

// A flattened-tree row identity (stable across re-flatten; NOT a selection key).
export type RowId = string;

// The folder's numeric id as a string. It keys `PickerState.folderScope`, so a folder picked as
// a unit projects back to the config's `folders[]` losslessly.
export type FolderKey = string;

// `ALL_TAB` shows every chat flat; any other value is a `FolderKey` scoping the list to one
// folder, plus that folder's "whole folder as a unit" row.
export type TabKey = string;
export const ALL_TAB: TabKey = 'all';

// The two INDEPENDENT access bits (chmod model): read and write toggle apart.
export interface AccessBits {
  readonly read: boolean;
  readonly write: boolean;
}

// The axis a key binding mutates — read vs write, never both at once.
export type AccessAxis = 'read' | 'write';

// Membership IS access, so this is a thin projection of the selection entry; a non-member reads
// as no access.
export interface EffectiveAccess {
  readonly member: boolean;
  readonly bits: AccessBits;
}

// Tri-state folder read-out — DERIVED bottom-up over ALL children, never stored.
export type TriState = 'none' | 'partial' | 'full';

export type PickerChatKind = 'user' | 'group' | 'channel' | 'self';

export interface ChatRow {
  readonly kind: 'chat';
  readonly id: RowId;
  readonly depth: number;
  readonly chatKey: ChatKey;
  readonly title: string;
  readonly chatKind: PickerChatKind;
  readonly username?: string;
  // Titles of EVERY folder this one chat appears under ("also in: Vendors").
  readonly folderTitles: readonly string[];
  // Telegram's native dialog order — 0 is most recent, `me` is -1 — the last-activity tiebreak
  // of the default sort. Absent sorts last.
  readonly activityRank?: number;
}

// A folder branch row. Tri-state + member counts are DERIVED, not stored here.
export interface FolderRow {
  readonly kind: 'folder';
  readonly id: RowId;
  readonly depth: number;
  readonly title: string;
  // Keys of ALL chats under this folder — the basis for tri-state + cascade.
  readonly childChatKeys: readonly ChatKey[];
  /**
   * The EXPLICIT (pinned ∪ included) members are the only ones the runtime folder resolver
   * tracks: a folder commits as a `folders[]` unit around these, while its rule-matched members
   * are not part of the ref.
   */
  readonly explicitChatKeys?: readonly ChatKey[];
  // Optional so hand-built rows stay valid. When absent the row still cascades child membership
  // but is never tracked as a scope unit.
  readonly folderKey?: FolderKey;
}

export type Row = ChatRow | FolderRow;

// Picker state

// Esc precedence + r/w-inert-while-typing both hinge on which pane has focus.
export type PickerFocus = 'tree' | 'search';

/**
 * The complete pure picker state: a flattened `rows` projection (the full tree) + the
 * id-keyed `selection` Map + cursor/search/visual axes. `rows` is the full tree; the
 * currently-visible subset (after tab scoping + filter) is a derived selector, so
 * clearing the filter restores everything with marks intact.
 */
export interface PickerState {
  // The endpoint being edited (header context).
  readonly endpointName: string;
  // Full flattened tree (folders + chats) in pre-order DFS.
  readonly rows: readonly Row[];
  // id-keyed explicit access per member chat. The source of truth.
  readonly selection: ReadonlyMap<ChatKey, AccessBits>;
  /**
   * Folders the operator picked as a scope unit (r/w on the folder-unit row). Keyed by
   * `FolderKey`; `setFolderAccess` adds, `clearAccess` on the folder row removes. The
   * mapper projects units with explicit members to `folders[]`; rule-only units
   * project their selected children as stable chat snapshots.
   */
  readonly folderScope: ReadonlySet<FolderKey>;
  /**
   * Snapshot of the chats selected (read or write) when the picker opened — the stable
   * key for the default display sort (selected-first). Held separate from the live
   * `selection` so toggling during a session never reorders rows under the cursor.
   * Optional: hand-built states omit it (then nothing floats).
   */
  readonly orderSelectedKeys?: ReadonlySet<ChatKey>;
  // Cursor position — the move-only axis. Undefined = empty tree.
  readonly cursorRowId: RowId | undefined;
  // Live fuzzy filter text; empty string = no filter (full tab shown).
  readonly query: string;
  // Which pane is focused — gates Esc precedence and r/w inertness while typing.
  readonly focus: PickerFocus;
  // Visual-range anchor (`v`); undefined when no range is active.
  readonly visualAnchorRowId: RowId | undefined;
  /**
   * The active horizontal tab (`ALL_TAB` or a `FolderKey`). It scopes the visible rows
   * (Telegram-style), so navigation/batch/search all operate within one tab — the
   * selection Map is untouched, so a chat marked under one tab stays marked everywhere.
   */
  readonly activeTabKey: TabKey;
  /**
   * How many chat rows the terminal can show at once (measured from stdout height).
   * The list is windowed to this many rows and scrolls internally; the surrounding
   * chrome (tabs / search / footer) never scrolls. Presentation-owned; the reducer only
   * clamps navigation, the screen sets it from the real terminal size.
   */
  readonly viewportRows: number;
}

// A derived horizontal tab: `All chats` then one per folder, in Telegram order.
export interface PickerTab {
  readonly key: TabKey;
  readonly title: string;
  // In-scope members / total chats in this tab (for the tab badge).
  readonly members: number;
  readonly total: number;
  readonly isFolder: boolean;
}

// A derived viewport window over the active tab's (filtered) rows.
export interface PickerWindow {
  // The slice of rows that actually fit the viewport.
  readonly rows: readonly Row[];
  // Index (into the full filtered list) of the first windowed row.
  readonly top: number;
  // Total rows in the active tab after filtering.
  readonly total: number;
  // Rows hidden above / below the window (drive the `↑ N` / `↓ N` indicators).
  readonly above: number;
  readonly below: number;
  // Index of the cursor within the full filtered list (−1 when none).
  readonly cursorIndex: number;
}

// The committed outcome the picker hands back to the wizard (see ui-port).
export interface PickerSelectionModel {
  readonly selection: ReadonlyMap<ChatKey, AccessBits>;
  /**
   * Folders picked as a scope unit (see `PickerState.folderScope`). Optional so a
   * bare membership model (no folders) stays valid; an absent set means "no
   * folder-as-scope-unit was picked" and the mapper projects only `chats[]`.
   */
  readonly folderScope?: ReadonlySet<FolderKey>;
}
