/**
 * PickerScreen — render + input-wiring tests (ink-testing-library, NO_COLOR theme
 * so frames are plain text). These pin the hero-step contract: a pure projection of
 * the reducer state (header tallies, tree rows with provenance read-outs, detail
 * line, auto-generated footer) AND the load-bearing INPUT seam — keys dispatch the
 * right reducer actions, and r/w are inert while the search box is focused.
 *
 * JSX-free (React.createElement) so the suite stays a `.test.ts` under the existing
 * Vitest config. `state` is controlled (the parent owns the reducer), so a spy
 * `dispatch` captures the actions a keypress would fire.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { render } from 'ink-testing-library';

import {
  PickerScreen,
  buildDetailText,
  computeHeaderCounts,
} from '../../../src/presentation/cli/ink/screens/PickerScreen.js';
import { createTheme } from '../../../src/presentation/cli/ink/theme.js';
import {
  createPickerState,
  type ChatRow,
  type FolderRow,
  type PickerAction,
  type PickerState,
} from '../../../src/presentation/cli/picker/index.js';
import type { PickerScreenComponentProps } from '../../../src/presentation/cli/ink/screens/PickerScreen.js';

const mono = createTheme({ colorsEnabled: false, unicodeGlyphs: false });

/** Ink parses keypresses + React flushes on ticks, so await before asserting. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

const folder: FolderRow = {
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

const baseState = (): PickerState => {
  const s = createPickerState({
    endpointName: 'support-reader',
    rows: [folder, releases, random],
  });
  return {
    ...s,
    cursorRowId: 'r-rel',
    selection: new Map([['c-rel', { read: true, write: false }]]),
  };
};

const mount = (
  state: PickerState,
  overrides: Partial<PickerScreenComponentProps> = {},
): { frame: () => string; stdin: { write: (s: string) => void }; dispatch: ReturnType<typeof vi.fn> } => {
  const dispatch = vi.fn<(action: PickerAction) => void>();
  const props: PickerScreenComponentProps = {
    state,
    onExit: vi.fn(),
    dispatch,
    theme: mono,
  };
  const r = render(createElement(PickerScreen, { ...props, ...overrides }) as ReactElement);
  return { frame: () => r.lastFrame() ?? '', stdin: r.stdin, dispatch };
};

const lastAction = (dispatch: ReturnType<typeof vi.fn>): PickerAction | undefined =>
  dispatch.mock.calls.length === 0
    ? undefined
    : (dispatch.mock.calls[dispatch.mock.calls.length - 1]?.[0] as PickerAction);

describe('PickerScreen render', () => {
  it('projects the reducer state into header, tabs, list, detail, and footer', () => {
    const frame = mount(baseState()).frame();
    expect(frame).toContain('Endpoint: "support-reader"');
    expect(frame).toContain('All chats'); // the horizontal tab strip
    expect(frame).toContain('Work'); // a folder tab
    expect(frame).toContain('# releases'); // chat row + kind glyph
    expect(frame).toContain('@rel_chan'); // handle
    expect(frame).toContain('also in: Work, VIP'); // multi-folder note
    expect(frame).toContain('detail:'); // in-process detail line
    expect(frame).toContain('2/2 shown'); // shown/total from selectors
  });

  it('shows the folder-unit row and that folder’s chats on a folder tab', () => {
    const onWork: PickerState = {
      ...baseState(),
      activeTabKey: 'f-work',
      cursorRowId: 'f-work',
    };
    const frame = mount(onWork).frame();
    expect(frame).toContain('Entire "Work" folder'); // the pinned unit row
    expect(frame).toContain('# releases'); // Work's chat is listed on its tab
  });
});

describe('PickerScreen input wiring', () => {
  it('dispatches a cursor move on j (tree focus)', async () => {
    const { stdin, dispatch } = mount(baseState());
    await tick(); // let Ink attach its stdin listener
    stdin.write('j');
    await tick();
    expect(lastAction(dispatch)).toEqual({ type: 'move', direction: 'down' });
  });

  it('dispatches a per-chat read TOGGLE on r while on a chat', async () => {
    const { stdin, dispatch } = mount(baseState());
    await tick();
    stdin.write('r');
    await tick();
    expect(lastAction(dispatch)).toEqual({ type: 'toggleBit', axis: 'read' });
  });

  it('treats r as filter text (NOT a write grant) while the search box is focused', async () => {
    const searching: PickerState = { ...baseState(), focus: 'search', query: '' };
    const { stdin, dispatch } = mount(searching);
    await tick();
    stdin.write('r');
    await tick();
    const actions = dispatch.mock.calls.map((c) => (c[0] as PickerAction).type);
    expect(actions).not.toContain('toggleBit'); // r is INERT while typing
    expect(lastAction(dispatch)).toEqual({ type: 'setFilter', query: 'r' });
  });

  it('opens the grouped help overlay on ? (local chrome state)', async () => {
    const { stdin, frame } = mount(baseState());
    await tick();
    stdin.write('?');
    await tick();
    expect(frame()).toContain('Keys');
  });

  it('enters search focus on /', async () => {
    const { stdin, dispatch } = mount(baseState());
    await tick();
    stdin.write('/');
    await tick();
    expect(lastAction(dispatch)).toEqual({ type: 'setFocus', focus: 'search' });
  });

  it('an UNLISTED key is a no-op — it does NOT hijack into search', async () => {
    const { stdin, dispatch } = mount(baseState());
    await tick();
    stdin.write('z'); // 'z' is bound to nothing
    await tick();
    const types = dispatch.mock.calls.map((c) => (c[0] as PickerAction).type);
    expect(types).not.toContain('setFilter');
    expect(types).not.toContain('setFocus');
  });
});

describe('PickerScreen pure helpers', () => {
  it('computeHeaderCounts tallies in-scope + writable by unique chat id', () => {
    const state: PickerState = {
      ...baseState(),
      selection: new Map([['c-rel', { read: true, write: true }]]),
    };
    expect(computeHeaderCounts(state)).toEqual({ inScope: 1, writable: 1 });
  });

  it('buildDetailText renders chat facts for the cursor row', () => {
    const text = buildDetailText(baseState(), releases);
    expect(text).toContain('# releases');
    expect(text).toContain('channel');
    expect(text).toContain('@rel_chan');
    expect(text).toContain('in folders: Work, VIP');
  });
});
