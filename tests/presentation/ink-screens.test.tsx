/**
 * Ink screen render tests: a JSX harness that projects the pure reducer state, and a
 * pre-computed `ReviewInput`, through the two live Ink screens and pins what the operator
 * actually sees.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';

import {
  PickerScreen,
  type PickerScreenComponentProps,
} from '../../src/presentation/cli/ink/screens/PickerScreen.js';
import { createTheme } from '../../src/presentation/cli/ink/theme.js';
import {
  createPickerState,
  pickerReducer,
  type AccessBits,
  type ChatRow,
  type FolderRow,
  type PickerAction,
  type PickerState,
  type Row,
} from '../../src/presentation/cli/picker/index.js';

const mono = createTheme({ colorsEnabled: false, unicodeGlyphs: false });

/**
 * --------------------------------------------------------------------------- Fixture tree —
 * two folders, four chats (one chat surfaced under two folders). Work (expanded) -> # releases
 * (@rel_chan, also in VIP), + random Clients (expanded) -> @ Acme, @ Globex
 * ---------------------------------------------------------------------------
 */
const work: FolderRow = {
  kind: 'folder',
  id: 'f-work',
  depth: 0,
  title: 'Work',
  childChatKeys: ['c-rel', 'c-rnd'],
};
const releases: ChatRow = {
  kind: 'chat',
  id: 'r-rel',
  depth: 1,
  chatKey: 'c-rel',
  title: 'releases',
  chatKind: 'channel',
  username: 'rel_chan',
  folderTitles: ['Work', 'VIP'],
};
const random: ChatRow = {
  kind: 'chat',
  id: 'r-rnd',
  depth: 1,
  chatKey: 'c-rnd',
  title: 'random',
  chatKind: 'group',
  folderTitles: ['Work'],
};
const clients: FolderRow = {
  kind: 'folder',
  id: 'f-clients',
  depth: 0,
  title: 'Clients',
  childChatKeys: ['c-acme', 'c-globex'],
};
const acme: ChatRow = {
  kind: 'chat',
  id: 'r-acme',
  depth: 1,
  chatKey: 'c-acme',
  title: 'Acme',
  chatKind: 'user',
  folderTitles: ['Clients', 'Vendors'],
};
const globex: ChatRow = {
  kind: 'chat',
  id: 'r-globex',
  depth: 1,
  chatKey: 'c-globex',
  title: 'Globex',
  chatKind: 'user',
  folderTitles: ['Clients'],
};

const rows: readonly Row[] = [work, releases, random, clients, acme, globex];

// Base selection: releases + Acme in scope read-only (explicit bits — membership IS access),
// random + Globex out of scope (absent = excluded).
const baseState = (): PickerState =>
  createPickerState({
    endpointName: 'support-reader',
    rows,
    selection: new Map<string, AccessBits>([
      ['c-rel', { read: true, write: false }],
      ['c-acme', { read: true, write: false }],
    ]),
  });

interface PickerHarness {
  readonly frame: () => string;
  readonly dispatch: ReturnType<typeof vi.fn>;
}

const mountPicker = (
  state: PickerState,
  overrides: Partial<PickerScreenComponentProps> = {},
): PickerHarness => {
  const dispatch = vi.fn<(action: PickerAction) => void>();
  const props: PickerScreenComponentProps = {
    state,
    onExit: vi.fn(),
    dispatch,
    theme: mono,
  };
  const instance = render(<PickerScreen {...props} {...overrides} />);
  return { frame: () => instance.lastFrame() ?? '', dispatch };
};

describe('PickerScreen — filtered render', () => {
  it('prunes to fuzzy matches (surfacing the owning folder) and hides the rest', () => {
    const filtered = pickerReducer(baseState(), { type: 'setFilter', query: 'rel' });
    const frame = mountPicker(filtered).frame();

    expect(frame).toContain('releases'); // the match
    expect(frame).toContain('1/4 shown'); // only 1 unique chat matches

    expect(frame).not.toContain('random'); // no 'r..e..l' subsequence
    expect(frame).not.toContain('Acme'); // non-matching chats hidden
    expect(frame).not.toContain('Globex');
    // NB: folder names (Work/Clients) still appear in the tab strip — filtering
    // scopes the LIST within the active tab, it does not hide the tabs.
  });

  it('preserves the id-keyed selection across filtering (marks are never dropped)', () => {
    const base = baseState();
    const filtered = pickerReducer(base, { type: 'setFilter', query: 'rel' });
    // The selection Map is carried through by reference — filtering only derives
    // the visible subset; it never mutates membership/rules.
    expect(filtered.selection).toBe(base.selection);
  });
});

describe('PickerScreen — folder tri-state', () => {
  it('renders a PARTIAL folder-unit as [-] on its tab when some children are members', () => {
    // Clients: Acme is a member, Globex is not -> 1 of 2 -> partial.
    const onClients: PickerState = {
      ...baseState(),
      activeTabKey: 'f-clients',
      cursorRowId: 'f-clients',
    };
    const frame = mountPicker(onClients).frame();
    expect(frame).toContain('[-]');
    expect(frame).toContain('Entire "Clients" folder');
  });

  it('renders a FULL folder-unit as [x] on its tab once every child is a member', () => {
    const state = baseState();
    const fullClients: PickerState = {
      ...state,
      activeTabKey: 'f-clients',
      cursorRowId: 'f-clients',
      selection: new Map(state.selection).set('c-globex', { read: true, write: false }),
    };
    const frame = mountPicker(fullClients).frame();
    expect(frame).toContain('[x]');
    expect(frame).toContain('Entire "Clients" folder');
  });
});

describe('PickerScreen — write escalation', () => {
  it('renders a writable chat as `rw` and flags the endpoint writable', () => {
    const state = baseState();
    const overridden: PickerState = {
      ...state,
      // releases gets an explicit per-chat WRITE override (the `*`, replaces default).
      selection: new Map(state.selection).set('c-rel', { read: true, write: true }),
    };
    const frame = mountPicker(overridden).frame();

    // The writable member reads out as the bold red `rw` token (no dots, no `*`).
    expect(frame).toContain('rw');
    // The header's writable tally (the ONE figure that warns) counts it.
    expect(frame).toContain('1 writable');
  });
});
