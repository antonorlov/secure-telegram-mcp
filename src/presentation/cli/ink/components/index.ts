// Props interfaces only, with no React import, so the contract is shared cheaply and the
// components stay thin renderers over the pure reducer state and selectors.
import type {
  AccessBits,
  EffectiveAccess,
  PickerAction,
  PickerState,
  PickerTab,
  Row,
  TabKey,
  TriState,
} from '../../picker/index.js';

export interface KeyChord {
  readonly key: string;
}

export type BindingGroup = 'move' | 'tabs' | 'select' | 'access' | 'search' | 'meta';

/**
 * The chords that trigger it, the action it produces (or a meta intent the screen handles), the
 * footer label, its group, and a context predicate that disables it — access bindings are off
 * while the search input has focus.
 */
export interface KeyBinding {
  readonly id: string;
  readonly chords: readonly KeyChord[];
  readonly label: string;
  readonly group: BindingGroup;
  // Omitted for meta bindings such as help or quit.
  readonly action?: PickerAction;
  // False hides the binding from the footer and disables it.
  readonly enabled?: (state: PickerState) => boolean;
}

export type BindingTable = readonly KeyBinding[];

export interface HeaderProps {
  readonly endpointName: string;
  readonly inScopeCount: number;
  readonly writableCount: number;
  readonly shown: number;
  readonly total: number;
}

export interface TreeRowProps {
  readonly row: Row;
  readonly isCursor: boolean;
  readonly inVisualRange: boolean;
  readonly effective?: EffectiveAccess;
  readonly triState?: TriState;
  // For a folder-unit row: the pinned body, e.g. `Entire "Work" folder · 42 chats`.
  readonly folderSummary?: string;
  readonly folderBits?: AccessBits;
}

export interface TabBarProps {
  readonly tabs: readonly PickerTab[];
  readonly activeKey: TabKey;
}

export interface SearchInputProps {
  readonly query: string;
  readonly focused: boolean;
  readonly matchCount: number;
}

export interface DetailLineProps {
  readonly text: string;
}

export interface FooterProps {
  readonly bindings: BindingTable;
  readonly state: PickerState;
}

export interface HelpOverlayProps {
  readonly bindings: BindingTable;
}

// Importing this barrel for values loads Ink, so only the lazy wizard path reaches it —
// `connect` never imports it. Type-only importers stay Ink-free.
export { ClassifiedLine } from './ClassifiedLine.js';
export { Header } from './Header.js';
export { TabBar } from './TabBar.js';
export { TitleCell, type TitleCellProps } from './TitleCell.js';
export { AccessToken, type AccessTokenProps } from './AccessToken.js';
export { TreeRow } from './TreeRow.js';
export { SearchInput } from './SearchInput.js';
export { DetailLine } from './DetailLine.js';
export { Footer } from './Footer.js';
export { HelpOverlay } from './HelpOverlay.js';
