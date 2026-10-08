// One table drives key dispatch, the context-sensitive footer and the grouped `?` help overlay,
// so the three can never drift apart.
import type {
  BindingGroup,
  BindingTable,
  KeyBinding,
  KeyChord,
} from './components/index.js';
import type { PickerAction, PickerState } from '../picker/index.js';

/**
 * The subset of Ink's `Key` we read, all optional so plain test objects satisfy it. Defined
 * here rather than imported from ink to keep this module framework-free; Ink's real `Key` is
 * structurally assignable.
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

// Returns `undefined` when the event is not a single actionable chord — a multi-char paste,
// which the caller routes to the filter input. Named keys win over the raw `input`.
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

const treeFocus = (s: PickerState): boolean => s.focus === 'tree';
const hasQuery = (s: PickerState): boolean => s.query.trim() !== '';

export const MetaBindingId = {
  Save: 'save',
  Find: 'find',
  Help: 'help',
  Back: 'back',
} as const;
export type MetaBindingId = (typeof MetaBindingId)[keyof typeof MetaBindingId];

const action = (a: PickerAction): { readonly action: PickerAction } => ({ action: a });

// Order matters twice: `matchBinding` returns the first enabled binding whose chord matches,
// and the footer and help render in this order.
export const defaultPickerBindings: BindingTable = Object.freeze([
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

export const isBindingEnabled = (binding: KeyBinding, state: PickerState): boolean =>
  binding.enabled === undefined ? true : binding.enabled(state);

/**
 * The first enabled binding whose chord matches, or `undefined` for an unbound key such as
 * printable filter text. The visual binding is a one-shot anchor: applying r/w consumes the
 * range.
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

export const selectFooterBindings = (
  state: PickerState,
  table: BindingTable = defaultPickerBindings,
): BindingTable => table.filter((b) => isBindingEnabled(b, state));

// The fixed help-group order (matches the footer's left-to-right grouping).
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

// The overlay documents the full keymap regardless of the current context, bucketed in
// `HELP_GROUP_ORDER`. Empty groups are omitted.
export const groupBindingsForHelp = (
  table: BindingTable = defaultPickerBindings,
): readonly HelpGroup[] =>
  HELP_GROUP_ORDER.map((group) => ({
    group,
    bindings: table.filter((b) => b.group === group),
  })).filter((g) => g.bindings.length > 0);

const NAMED_CHORD_LABEL: Readonly<Record<string, string>> = Object.freeze({
  down: 'dn',
  escape: 'esc',
  backspace: 'bksp',
  ' ': 'spc',
});

export const formatChord = (chord: KeyChord): string => {
  return NAMED_CHORD_LABEL[chord.key] ?? chord.key;
};

export const formatBindingHint = (binding: KeyBinding): string =>
  binding.chords.map(formatChord).join('/');
