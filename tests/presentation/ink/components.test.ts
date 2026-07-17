/**
 * Ink picker components — render smoke + read-out tests via ink-testing-library
 * (NO_COLOR theme, so frames are plain text and assertions are stable). These
 * pin the user-visible contract each parallel screen builds on: the hero header,
 * the per-row provenance read-out, the auto-generated footer (enabled subset),
 * and the grouped help overlay.
 *
 * JSX-free (React.createElement) so the suite stays a `.test.ts` under the
 * existing Vitest config.
 */
import { describe, it, expect } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { render } from 'ink-testing-library';

import {
  DetailLine,
  Footer,
  Header,
  HelpOverlay,
  SearchInput,
  TreeRow,
} from '../../../src/presentation/cli/ink/components/index.js';
import { defaultPickerBindings } from '../../../src/presentation/cli/ink/bindings.js';
import { createTheme } from '../../../src/presentation/cli/ink/theme.js';
import {
  createPickerState,
  type ChatRow,
  type EffectiveAccess,
  type FolderRow,
  type PickerState,
} from '../../../src/presentation/cli/picker/index.js';

const mono = createTheme({ colorsEnabled: false, unicodeGlyphs: false });
const frameOf = (element: ReactElement): string => render(element).lastFrame() ?? '';

const chatRow: ChatRow = {
  kind: 'chat',
  id: 'r-c1',
  depth: 1,
  chatKey: 'c1',
  title: 'releases',
  chatKind: 'channel',
  username: 'rel_chan',
  folderTitles: ['Work', 'VIP'],
};
const folderRow: FolderRow = {
  kind: 'folder',
  id: 'f1',
  depth: 0,
  title: 'Clients',
  childChatKeys: ['c1', 'c2'],
};

describe('Header', () => {
  it('renders the hero context line', () => {
    const frame = frameOf(
      createElement(Header, {
        endpointName: 'support',
        inScopeCount: 9,
        writableCount: 1,
        shown: 42,
        total: 380,
        theme: mono,
      }),
    );
    expect(frame).toContain('Endpoint: "support"');
    expect(frame).toContain('9 in scope');
    expect(frame).toContain('1 writable');
    expect(frame).toContain('42/380 shown');
  });
});

describe('TreeRow', () => {
  it('renders a writable per-chat override with cursor, handle, and cross-folder note', () => {
    const effective: EffectiveAccess = {
      member: true,
      bits: { read: true, write: true },
    };
    const frame = frameOf(
      createElement(TreeRow, {
        row: chatRow,
        isCursor: true,
        inVisualRange: false,
        effective,
        theme: mono,
      }),
    );
    expect(frame).toContain('# releases');
    expect(frame).toContain('@rel_chan');
    expect(frame).toContain('rw'); // minimal token: writable => rw (no dots, no *)
    expect(frame).toContain('also in: Work, VIP');
    expect(frame).toContain('>'); // cursor caret
  });

  it('renders a folder-unit row with a derived partial tri-state', () => {
    const frame = frameOf(
      createElement(TreeRow, {
        row: folderRow,
        isCursor: false,
        inVisualRange: false,
        triState: 'partial',
        folderSummary: 'Entire "Clients" folder · 130 chats',
        theme: mono,
      }),
    );
    expect(frame).toContain('Entire "Clients" folder');
    expect(frame).toContain('[-]'); // partial
    expect(frame).toContain('130 chats');
  });
});

describe('Footer (auto-generated from the binding table)', () => {
  const base = createPickerState({
    endpointName: 'support',
    rows: [folderRow, chatRow],
  });
  const onChat: PickerState = { ...base, cursorRowId: 'r-c1' };

  it('shows the access grants while on a chat in the tree', () => {
    const frame = frameOf(
      createElement(Footer, { bindings: defaultPickerBindings, state: onChat, theme: mono }),
    );
    expect(frame).toContain('read');
    expect(frame).toContain('write');
    expect(frame).toContain('remove'); // 0/bksp — out of scope
  });

  it('hides the access grants while the search box is focused', () => {
    const searching: PickerState = { ...onChat, focus: 'search', query: 'rel' };
    const frame = frameOf(
      createElement(Footer, {
        bindings: defaultPickerBindings,
        state: searching,
        theme: mono,
      }),
    );
    expect(frame).not.toContain('read');
    expect(frame).not.toContain('write');
  });
});

describe('HelpOverlay', () => {
  it('renders the full grouped keymap', () => {
    const frame = frameOf(
      createElement(HelpOverlay, { bindings: defaultPickerBindings, theme: mono }),
    );
    expect(frame).toContain('Keys');
    expect(frame).toContain('Move');
    expect(frame).toContain('Access');
    expect(frame).toContain('save'); // explicit save key
    expect(frame).toContain('cancel'); // esc / q
  });
});

describe('SearchInput', () => {
  it('shows the query, focus caret, and match count', () => {
    const frame = frameOf(
      createElement(SearchInput, {
        query: 'rel',
        focused: true,
        matchCount: 42,
        theme: mono,
      }),
    );
    expect(frame).toContain('search |');
    expect(frame).toContain('rel');
    expect(frame).toContain('42 match');
  });
});

describe('DetailLine', () => {
  it('frames the cursor-row detail text', () => {
    const frame = frameOf(
      createElement(DetailLine, { text: '# releases · channel', theme: mono }),
    );
    expect(frame).toContain('detail:');
    expect(frame).toContain('# releases');
  });
});
