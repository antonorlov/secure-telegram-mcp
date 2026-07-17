/**
 * Binding table — one array that drives, all from the same data:
 *   1. key dispatch (a normalised keypress -> the picker action it fires),
 *   2. the context-sensitive footer (only bindings enabled for the current state show), and
 *   3. the grouped `?` help overlay.
 * Keys and footer can never drift because they are projections of the same data.
 *
 * Framework-free: no Ink/React import. The Ink layer normalises its key event into a
 * `KeyChord` (via `normalizeKeyEvent`) and asks `matchBinding` what to do — so the whole
 * keymap is pure and unit-testable, and `connect` never reaches Ink.
 *
 * The WYSIWYG keymap (membership IS access):
 *  - `r` (alias: Space, the TUI select idiom — read-only IS selection here) and `w`
 *    are the only grant keys (chat / folder-unit row / visual range) and are
 *    hidden/inert while the search input is focused, so typing a chat's name can never
 *    grant write;
 *  - `0`/Backspace removes from scope; `s` saves; Esc cancels.
 */
import type {
  BindingGroup,
  BindingTable,
  KeyBinding,
  KeyChord,
} from './components/index.js';
import type { PickerAction, PickerState } from '../picker/index.js';

// Key-event normalisation (Ink's Key -> our framework-free KeyChord)

/**
 * The subset of Ink's `Key` we read, all optional so plain test objects satisfy
 * it. Defined here (not imported from ink) to keep this module framework-free;
 * Ink's real `Key` is structurally assignable.
 */
export interface KeyEventLike {
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly ctrl?: boolean;
}

/**
 * Normalise an Ink `(input, key)` pair into a single canonical `KeyChord`, or
 * `undefined` when the event is not a single actionable chord (e.g. a multi-char
 * paste — the caller routes that to the filter input). Named keys win over the
 * raw `input`; printable characters are kept case-sensitive (so `r` and `R` are
 * distinct chords). Ctrl-modified printables normalise to `undefined` — the settled
 * keymap has no ctrl chords, so they stay exactly as inert as an unbound key.
 */
export const normalizeKeyEvent = (
  input: string,
  key: KeyEventLike,
): KeyChord | undefined => {
  if (key.upArrow === true) return { key: 'up' };
  if (key.downArrow === true) return { key: 'down' };
  if (key.leftArrow === true) return { key: 'left' };
  if (key.rightArrow === true) return { key: 'right' };
  if (key.return === true) return { key: 'return' };
  if (key.escape === true) return { key: 'escape' };
  if (key.backspace === true || key.delete === true) return { key: 'backspace' };
  if (key.ctrl === true) return undefined;
  if (input.length === 1) {
    return { key: input };
  }
  return undefined;
};

const chordEquals = (a: KeyChord, b: KeyChord): boolean => a.key === b.key;

// Context predicates (the `enabled` gates — keep the three axes from crossing)

const treeFocus = (s: PickerState): boolean => s.focus === 'tree';
const hasQuery = (s: PickerState): boolean => s.query.trim() !== '';

// Meta binding ids (bindings with no action — the shell interprets these)

export const MetaBindingId = {
  Save: 'save',
  Find: 'find',
  Help: 'help',
  Back: 'back',
} as const;
export type MetaBindingId = (typeof MetaBindingId)[keyof typeof MetaBindingId];

const action = (a: PickerAction): { readonly action: PickerAction } => ({ action: a });

// The table

/**
 * The default picker keymap. Order matters twice: `matchBinding` returns the first enabled
 * binding whose chord matches, and the footer/help render in this order. Every chord is
 * convention-aligned and dual-bound where a vi-style alias exists.
 */
export const defaultPickerBindings: BindingTable = Object.freeze([
  // --- move (cursor only) ---
  {
    id: 'move-up',
    chords: [{ key: 'up' }, { key: 'k' }],
    label: 'up',
    group: 'move',
    ...action({ type: 'move', direction: 'up' }),
  },
  {
    id: 'move-down',
    chords: [{ key: 'down' }, { key: 'j' }],
    label: 'down',
    group: 'move',
    ...action({ type: 'move', direction: 'down' }),
  },
  // --- tabs (horizontal folder tabs replace tree expand/collapse) ---
  {
    id: 'prev-tab',
    chords: [{ key: 'left' }, { key: 'h' }],
    label: 'prev tab',
    group: 'tabs',
    enabled: treeFocus,
    ...action({ type: 'prevTab' }),
  },
  {
    id: 'next-tab',
    chords: [{ key: 'right' }, { key: 'l' }],
    label: 'next tab',
    group: 'tabs',
    enabled: treeFocus,
    ...action({ type: 'nextTab' }),
  },
  // --- select helpers (mark many rows, then r/w applies the access) ---
  {
    id: 'visual',
    chords: [{ key: 'v' }],
    label: 'range',
    group: 'select',
    enabled: treeFocus,
    ...action({ type: 'beginVisualRange' }),
  },
  {
    id: 'select-all',
    chords: [{ key: 'a' }],
    label: 'all shown',
    group: 'select',
    enabled: treeFocus,
    ...action({ type: 'selectAllShown' }),
  },
  {
    id: 'invert',
    chords: [{ key: 'i' }],
    label: 'invert',
    group: 'select',
    enabled: treeFocus,
    ...action({ type: 'invertShown' }),
  },
  // --- access (r/w — the one way to grant; inert while typing) ---
  {
    id: 'read',
    // Space aliases r: the checkbox idiom — "select" = grant the least-privilege
    // read tier. Write stays an explicit, separate keypress.
    chords: [{ key: 'r' }, { key: ' ' }],
    label: 'read',
    group: 'access',
    // Live on any tree row: chat = flip its read bit; folder-unit row = the whole folder
    // read-only; visual range = the range — never falls through to search.
    enabled: treeFocus,
    ...action({ type: 'toggleBit', axis: 'read' }),
  },
  {
    id: 'write',
    chords: [{ key: 'w' }],
    label: 'write',
    group: 'access',
    enabled: treeFocus,
    ...action({ type: 'toggleBit', axis: 'write' }),
  },
  {
    id: 'clear-access',
    chords: [{ key: '0' }, { key: 'backspace' }],
    label: 'remove',
    group: 'access',
    enabled: treeFocus,
    ...action({ type: 'clearAccess' }),
  },
  // --- search / filter ---
  {
    id: MetaBindingId.Find,
    chords: [{ key: '/' }],
    label: 'find',
    group: 'search',
    enabled: treeFocus,
  },
  {
    id: 'search-next',
    chords: [{ key: 'n' }],
    label: 'next',
    group: 'search',
    enabled: (s: PickerState): boolean => treeFocus(s) && hasQuery(s),
    ...action({ type: 'searchNext' }),
  },
  {
    id: 'search-prev',
    chords: [{ key: 'N' }],
    label: 'prev',
    group: 'search',
    enabled: (s: PickerState): boolean => treeFocus(s) && hasQuery(s),
    ...action({ type: 'searchPrev' }),
  },
  // --- meta (no action — the shell interprets these by id) ---
  {
    id: MetaBindingId.Save,
    chords: [{ key: 's' }, { key: 'S' }],
    label: 'save',
    group: 'meta',
    enabled: treeFocus,
  },
  {
    id: MetaBindingId.Help,
    chords: [{ key: '?' }],
    label: 'help',
    group: 'meta',
    enabled: treeFocus,
  },
  {
    id: MetaBindingId.Back,
    chords: [{ key: 'escape' }],
    label: 'cancel',
    group: 'meta',
  },
] as const);

// Projections (dispatch / footer / help all derive from the same table)

/** A binding is live unless its `enabled` predicate says otherwise. */
export const isBindingEnabled = (binding: KeyBinding, state: PickerState): boolean =>
  binding.enabled === undefined ? true : binding.enabled(state);

/**
 * The dispatch resolver: the first enabled binding whose chord matches the keypress, or
 * `undefined` (an unbound key — e.g. printable filter text). The visual binding is a
 * one-shot anchor; applying r/w consumes the range.
 */
export const matchBinding = (
  state: PickerState,
  chord: KeyChord,
  table: BindingTable = defaultPickerBindings,
): KeyBinding | undefined =>
  table.find(
    (b) =>
      isBindingEnabled(b, state) && b.chords.some((c) => chordEquals(c, chord)),
  );

/** The context-sensitive footer set: the enabled bindings, in table order. */
export const selectFooterBindings = (
  state: PickerState,
  table: BindingTable = defaultPickerBindings,
): BindingTable => table.filter((b) => isBindingEnabled(b, state));

/** The fixed help-group order (matches the footer's left-to-right grouping). */
export const HELP_GROUP_ORDER: readonly BindingGroup[] = Object.freeze([
  'move',
  'tabs',
  'select',
  'access',
  'search',
  'meta',
]);

export interface HelpGroup {
  readonly group: BindingGroup;
  readonly bindings: BindingTable;
}

/**
 * The grouped `?` overlay model: every binding (the overlay documents the full keymap,
 * regardless of the current context), bucketed in `HELP_GROUP_ORDER`. Empty groups are omitted.
 */
export const groupBindingsForHelp = (
  table: BindingTable = defaultPickerBindings,
): readonly HelpGroup[] =>
  HELP_GROUP_ORDER.map((group) => ({
    group,
    bindings: table.filter((b) => b.group === group),
  })).filter((g) => g.bindings.length > 0);

// Chord display (footer + help share one renderer — no drift)

const NAMED_CHORD_LABEL: Readonly<Record<string, string>> = Object.freeze({
  down: 'dn',
  escape: 'esc',
  backspace: 'bksp',
  ' ': 'spc',
});

/** A single chord's display token, e.g. `up`, `spc`, `/`. */
export const formatChord = (chord: KeyChord): string => {
  return NAMED_CHORD_LABEL[chord.key] ?? chord.key;
};

/** A binding's footer hint: its chords joined by `/`, e.g. `up/k`, `spc/tab`. */
export const formatBindingHint = (binding: KeyBinding): string =>
  binding.chords.map(formatChord).join('/');
