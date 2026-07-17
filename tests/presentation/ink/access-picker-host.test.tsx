/**
 * AccessPickerHost — the picker->review sub-tree's EXIT routing. Pins the explicit
 * save/cancel model: `s` SAVES (ordinary read-only chat edits commit at once;
 * WRITABLE access and live-tracked folder changes reach ReviewScreen first), and
 * Esc/`q` CANCEL (discard, no commit).
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';

import {
  AccessPickerHost,
  type AccessPickerResult,
} from '../../../src/presentation/cli/ink/run-access-picker.js';
import { buildPickerTree } from '../../../src/presentation/cli/picker-bridge.js';
import {
  createPickerState,
  pickerReducer,
  type PickerState,
} from '../../../src/presentation/cli/picker/index.js';
import type { AccountChatDto as SetupChat } from '../../../src/application/index.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
const ESC = '\x1b';
const SAVE = 's';

const chats: readonly SetupChat[] = [{ id: '-1', title: 'Chan', kind: 'channel' }];
const { rows } = buildPickerTree(chats);

/** A picker state with the one chat toggled to the given access, cursor on it. */
const withAccess = (axis: 'read' | 'write'): PickerState => {
  const s = createPickerState({ endpointName: 'reader', rows });
  return pickerReducer({ ...s, cursorRowId: 'chat:-1' }, { type: 'toggleBit', axis });
};

type OnDone = (result: AccessPickerResult) => void;

const mount = (
  state: PickerState,
  onDone: OnDone,
): ReturnType<typeof render> =>
  render(<AccessPickerHost initialState={state} onDone={onDone} />);

describe('AccessPickerHost — explicit save/cancel', () => {
  it('`s` commits a READ-ONLY selection directly (no review gate)', async () => {
    const onDone = vi.fn<OnDone>();
    const r = mount(withAccess('read'), onDone);
    await tick();
    r.stdin.write(SAVE);
    await tick();
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ committed: true }));
  });

  it('`s` sends a WRITABLE selection to the review gate (does NOT commit yet)', async () => {
    const onDone = vi.fn<OnDone>();
    const r = mount(withAccess('write'), onDone);
    await tick();
    r.stdin.write(SAVE);
    await tick();
    expect(onDone).not.toHaveBeenCalled();
    expect(r.lastFrame() ?? '').toContain('Write blast radius');
  });

  it('`s` sends a READ-ONLY folder-unit change to the review gate', async () => {
    const tree = buildPickerTree(chats, [
      { id: 5, title: 'Work', chatIds: ['-1'] },
    ]);
    // The baseline is captured at mount: nothing selected. Granting the folder
    // live (r on the folder row) makes it a scope unit — the review-gated diff.
    const initial: PickerState = {
      ...createPickerState({ endpointName: 'reader', rows: tree.rows }),
      cursorRowId: 'folder:5',
    };
    const onDone = vi.fn<OnDone>();
    const r = mount(initial, onDone);

    await tick();
    r.stdin.write('r'); // grant the folder read-only -> it becomes a scope unit
    await tick();
    r.stdin.write(SAVE);
    await tick();

    expect(onDone).not.toHaveBeenCalled();
    expect(r.lastFrame() ?? '').toContain(
      'tracks explicit members; rule matches are snapshots',
    );
  });

  it('Esc CANCELS — discards the edit without committing', async () => {
    const onDone = vi.fn<OnDone>();
    const r = mount(withAccess('read'), onDone);
    await tick();
    r.stdin.write(ESC);
    await tick();
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ committed: false }));
  });
});
