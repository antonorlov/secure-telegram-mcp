/**
 * Binding table — the SSOT that drives dispatch + footer + help. Pinned here:
 *   - key-event normalisation (named keys, printable case, inert ctrl, multi-char),
 *   - matchBinding resolves the FIRST enabled binding (Space splits chat/folder),
 *   - access grants are INERT while the search box is focused (no write-by-typing),
 *   - footer is the enabled subset; help is the full grouped keymap,
 *   - chord/hint formatting.
 */
import { describe, it, expect } from 'vitest';
import {
  defaultPickerBindings,
  formatBindingHint,
  formatChord,
  groupBindingsForHelp,
  HELP_GROUP_ORDER,
  isBindingEnabled,
  matchBinding,
  normalizeKeyEvent,
  selectFooterBindings,
} from '../../../src/presentation/cli/ink/bindings.js';
import {
  createPickerState,
  type ChatRow,
  type FolderRow,
  type PickerState,
} from '../../../src/presentation/cli/picker/index.js';

const folderRow: FolderRow = {
  kind: 'folder',
  id: 'f1',
  depth: 0,
  title: 'Work',
  childChatKeys: ['c1'],
};
const chatRow: ChatRow = {
  kind: 'chat',
  id: 'r-c1',
  depth: 1,
  chatKey: 'c1',
  title: 'releases',
  chatKind: 'channel',
  folderTitles: ['Work'],
};

const base = createPickerState({ endpointName: 'support', rows: [folderRow, chatRow] });
const onFolder: PickerState = { ...base, cursorRowId: 'f1' };
const onChat: PickerState = { ...base, cursorRowId: 'r-c1' };
const searching: PickerState = { ...onChat, focus: 'search', query: 'rel' };

describe('normalizeKeyEvent', () => {
  it('maps named keys', () => {
    expect(normalizeKeyEvent('', { upArrow: true })).toEqual({ key: 'up' });
    expect(normalizeKeyEvent('', { downArrow: true })).toEqual({ key: 'down' });
    expect(normalizeKeyEvent('', { leftArrow: true })).toEqual({ key: 'left' });
    expect(normalizeKeyEvent('', { rightArrow: true })).toEqual({ key: 'right' });
    expect(normalizeKeyEvent('', { return: true })).toEqual({ key: 'return' });
    expect(normalizeKeyEvent('', { escape: true })).toEqual({ key: 'escape' });
    expect(normalizeKeyEvent('', { backspace: true })).toEqual({ key: 'backspace' });
    expect(normalizeKeyEvent('', { delete: true })).toEqual({ key: 'backspace' });
  });

  it('keeps printable characters case-sensitive and leaves ctrl chords inert', () => {
    expect(normalizeKeyEvent('r', {})).toEqual({ key: 'r' });
    expect(normalizeKeyEvent('R', {})).toEqual({ key: 'R' });
    expect(normalizeKeyEvent('c', { ctrl: true })).toBeUndefined();
  });

  it('returns undefined for a multi-char paste', () => {
    expect(normalizeKeyEvent('hello', {})).toBeUndefined();
  });
});

describe('matchBinding (the three orthogonal axes)', () => {
  it('Space ALIASES r — the checkbox idiom grants the read tier, never write', () => {
    expect(matchBinding(onChat, { key: ' ' })?.action).toEqual({
      type: 'toggleBit',
      axis: 'read',
    });
    expect(matchBinding(onFolder, { key: ' ' })?.action).toEqual({
      type: 'toggleBit',
      axis: 'read',
    });
  });

  it('lowercase r TOGGLES the per-chat read bit on a chat row', () => {
    expect(matchBinding(onChat, { key: 'r' })?.action).toEqual({
      type: 'toggleBit',
      axis: 'read',
    });
  });

  it('access grants are INERT while the search box is focused', () => {
    expect(matchBinding(searching, { key: 'r' })).toBeUndefined();
    expect(matchBinding(searching, { key: 'w' })).toBeUndefined();
    expect(matchBinding(searching, { key: 'R' })).toBeUndefined();
    // Space falls through to the query text (typing a space can never grant).
    expect(matchBinding(searching, { key: ' ' })).toBeUndefined();
  });

  it('uppercase R/W are unbound (no group default in the WYSIWYG model)', () => {
    expect(matchBinding(onChat, { key: 'R' })).toBeUndefined();
    expect(matchBinding(onChat, { key: 'W' })).toBeUndefined();
  });

  it('arrows move; a meta key (find) resolves with no action', () => {
    expect(matchBinding(onChat, { key: 'up' })?.action).toEqual({
      type: 'move',
      direction: 'up',
    });
    const find = matchBinding(onChat, { key: '/' });
    expect(find?.id).toBe('find');
    expect(find?.action).toBeUndefined();
  });

  it('returns undefined for an unbound key', () => {
    expect(matchBinding(onChat, { key: 'z' })).toBeUndefined();
  });
});

describe('footer / help projections', () => {
  it('the footer is the enabled subset — access grants vanish while typing', () => {
    const labels = selectFooterBindings(searching).map((b) => b.label);
    expect(labels).not.toContain('read');
    expect(labels).not.toContain('write');
    expect(selectFooterBindings(onChat).map((b) => b.label)).toContain('read');
  });

  it('help groups the FULL keymap in the fixed order, omitting nothing', () => {
    const groups = groupBindingsForHelp();
    expect(groups.map((g) => g.group)).toEqual([...HELP_GROUP_ORDER]);
    const total = groups.reduce((n, g) => n + g.bindings.length, 0);
    expect(total).toBe(defaultPickerBindings.length);
    const access = groups.find((g) => g.group === 'access');
    expect(access?.bindings.map((b) => b.id)).toContain('write');
  });

  it('isBindingEnabled defaults to true when no predicate is set', () => {
    const back = defaultPickerBindings.find((b) => b.id === 'back');
    expect(back).toBeDefined();
    if (back !== undefined) expect(isBindingEnabled(back, searching)).toBe(true);
  });
});

describe('chord display', () => {
  it('formats a single chord', () => {
    expect(formatChord({ key: 'up' })).toBe('up');
    expect(formatChord({ key: '/' })).toBe('/');
  });

  it('joins a binding’s chords with a slash', () => {
    const moveUp = defaultPickerBindings.find((b) => b.id === 'move-up');
    expect(moveUp).toBeDefined();
    if (moveUp !== undefined) expect(formatBindingHint(moveUp)).toBe('up/k');
    const read = defaultPickerBindings.find((b) => b.id === 'read');
    expect(read).toBeDefined();
    if (read !== undefined) expect(formatBindingHint(read)).toBe('r/spc');
  });
});
