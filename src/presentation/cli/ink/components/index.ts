/**
 * Ink component contracts — the props/view-model shapes the picker components implement.
 * Framework-free: props interfaces only, no React import, so the contract is shared cheaply
 * and the components stay thin renderers over the pure reducer state + selectors.
 *
 * The binding table: `KeyBinding[]` is the one table that drives key dispatch, the
 * auto-generated context-sensitive footer, and the grouped `?` help overlay (keys + footer
 * never drift). Each binding is convention-aligned and dual-bound (e.g. up + k), carries a
 * help group, a label, and an `enabled` predicate so the footer is context-sensitive (e.g.
 * r/w hidden while typing).
 */
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

// Binding table (drives keys + footer + help)

/** A single physical key/chord (already normalised from Ink's key event). */
export interface KeyChord {
  /** Printable key or named key ('up', 'return', 'escape', 'space', 'backspace'). */
  readonly key: string;
}

/** Help-overlay grouping for the grouped `?` screen + footer ordering. */
export type BindingGroup = 'move' | 'tabs' | 'select' | 'access' | 'search' | 'meta';

/**
 * One row of the binding table: the chords that trigger it, the action it produces (or a
 * meta intent the screen handles), the footer/help label, its group, and a context predicate
 * that hides/disables it (e.g. access bindings are disabled while the search input is
 * focused — typing never grants write).
 */
export interface KeyBinding {
  readonly id: string;
  readonly chords: readonly KeyChord[];
  /** Footer/help label, e.g. 'pick', 'read', 'find'. */
  readonly label: string;
  readonly group: BindingGroup;
  /** The picker action this binding dispatches; omitted for meta (e.g. help/quit). */
  readonly action?: PickerAction;
  /** Context predicate — false hides the binding from the footer + disables it. */
  readonly enabled?: (state: PickerState) => boolean;
}

export type BindingTable = readonly KeyBinding[];

// Component props

/** The hero header: endpoint, in-scope + writable counts. */
export interface HeaderProps {
  readonly endpointName: string;
  readonly inScopeCount: number;
  readonly writableCount: number;
  /** "42/380 shown" live filter read-out. */
  readonly shown: number;
  readonly total: number;
}

/** One rendered list row — a chat, or the pinned "whole folder" unit row. */
export interface TreeRowProps {
  readonly row: Row;
  readonly isCursor: boolean;
  readonly inVisualRange: boolean;
  /** For chats: the resolved effective access; for folder rows: undefined. */
  readonly effective?: EffectiveAccess;
  /** For a folder-unit row: the derived tri-state; for chats: undefined. */
  readonly triState?: TriState;
  /** For a folder-unit row: the pinned body, e.g. `Entire "Work" folder · 42 chats`. */
  readonly folderSummary?: string;
  /** For a folder-unit row: the uniform member access when selected (row formats it). */
  readonly folderBits?: AccessBits;
}

/** The horizontal folder-tab strip: `All chats` then one tab per folder. */
export interface TabBarProps {
  readonly tabs: readonly PickerTab[];
  readonly activeKey: TabKey;
}

/** The live fuzzy-search input (focus gates r/w inertness). */
export interface SearchInputProps {
  readonly query: string;
  readonly focused: boolean;
  readonly matchCount: number;
}

/** The in-process detail line for the cursor row. */
export interface DetailLineProps {
  readonly text: string;
}

/** The auto-generated, context-sensitive footer (rendered FROM the binding table). */
export interface FooterProps {
  readonly bindings: BindingTable;
  readonly state: PickerState;
}

/** The grouped `?` help overlay (also rendered from the binding table). */
export interface HelpOverlayProps {
  readonly bindings: BindingTable;
}

// Component implementations (the one import site for the picker chrome). These are Ink
// (.tsx) modules; importing this barrel for values loads Ink, so only the lazy wizard path
// reaches it — `connect` never imports it. Type-only importers stay Ink-free under
// `verbatimModuleSyntax`.
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
