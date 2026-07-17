/**
 * ReviewScreen tests — render smoke + the SECURITY-FIRST input contract, driven
 * through ink-testing-library's fake stdin (NO_COLOR theme so frames are plain
 * text). These pin the load-bearing rules: the resolved matrix / diff / inverse
 * blast-radius read-outs render; a read-only save needs no prompt; a WRITABLE
 * save is GATED behind typing the endpoint name; a mismatch is RECOVERABLE (no
 * decision, prompt stays); the default action is the safe cancel.
 *
 * Input is asynchronous (Ink parses keypresses + React flushes state on ticks),
 * so each interaction is awaited before asserting.
 *
 * JSX-free (React.createElement) so the suite stays a `.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { render } from 'ink-testing-library';

import {
  ReviewScreen,
  type ReviewScreenViewProps,
} from '../../../src/presentation/cli/ink/screens/ReviewScreen.js';
import { createTheme } from '../../../src/presentation/cli/ink/theme.js';
import type {
  ReviewDecision,
  ReviewInput,
} from '../../../src/presentation/cli/ink/ui-port.js';

const mono = createTheme({ colorsEnabled: false, unicodeGlyphs: false });

const ESC = '';
const ENTER = '\r';
const BACKSPACE = '';

/** Let Ink flush its keypress queue + React commit the resulting state. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

const readOnlyInput: ReviewInput = {
  endpointName: 'support-reader',
  matrix: [
    {
      title: 'eng-standup',
      bits: { read: true, write: false },
    },
  ],
  diff: ['+ eng-standup (read)'],
  blastRadius: [],
  hasWritable: false,
};

const writableInput: ReviewInput = {
  endpointName: 'releases-bot',
  matrix: [
    {
      title: 'releases',
      bits: { read: true, write: true },
    },
  ],
  diff: ['~ releases (read -> read+write)'],
  blastRadius: [{ title: 'releases', writableFromEndpoints: ['releases-bot'] }],
  hasWritable: true,
};

const mount = (
  input: ReviewInput,
  onDecide: (d: ReviewDecision) => void,
): ReturnType<typeof render> =>
  render(
    createElement(ReviewScreen, {
      input,
      onDecide,
      theme: mono,
    } satisfies ReviewScreenViewProps),
  );

/** Mount + wait one tick so Ink has attached its stdin listener before input. */
const mountReady = async (
  input: ReviewInput,
  onDecide: (d: ReviewDecision) => void,
): Promise<ReturnType<typeof render>> => {
  const harness = mount(input, onDecide);
  await tick();
  return harness;
};

describe('ReviewScreen — read-outs', () => {
  it('renders the resolved matrix, diff, and blast-radius audit', () => {
    const { lastFrame } = mount(writableInput, vi.fn());
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Review — "releases-bot"');
    expect(frame).toContain('releases');
    expect(frame).toContain('rw'); // resolved read+write token (shared with the picker)
    // The one-line write-tier consent read-out spells out what the write bit unlocks.
    expect(frame).toContain('write = send · edit · delete · forward · draft · mark_read · react');
    expect(frame).toContain('read -> read+write'); // diff line
    expect(frame).toContain('Write blast radius');
    expect(frame).toContain('writable from: releases-bot');
  });
});

describe('ReviewScreen — read-only save (no escalation, no prompt)', () => {
  it('confirms the save immediately on enter when nothing is writable', async () => {
    const onDecide = vi.fn();
    const { stdin } = await mountReady(readOnlyInput, onDecide);
    stdin.write(ENTER);
    await tick();
    expect(onDecide).toHaveBeenCalledWith({ type: 'confirm-save' });
  });
});

describe('ReviewScreen — writable save is gated by the typed name', () => {
  it('does NOT save on enter; opens the type-the-name gate', async () => {
    const onDecide = vi.fn();
    const { stdin, lastFrame } = await mountReady(writableInput, onDecide);
    stdin.write(ENTER);
    await tick();
    expect(onDecide).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('Type "releases-bot" to confirm save');
  });

  it('rejects a wrong name as a RECOVERABLE error (prompt stays, no decision)', async () => {
    const onDecide = vi.fn();
    const { stdin, lastFrame } = await mountReady(writableInput, onDecide);
    stdin.write(ENTER); // open gate
    await tick();
    stdin.write('wrong');
    await tick();
    stdin.write(ENTER); // submit mismatch
    await tick();
    expect(onDecide).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('does not match');
  });

  it('confirms the save once the exact endpoint name is typed', async () => {
    const onDecide = vi.fn();
    const { stdin } = await mountReady(writableInput, onDecide);
    stdin.write(ENTER); // open gate
    await tick();
    stdin.write('releases-bot');
    await tick();
    stdin.write(ENTER); // submit match
    await tick();
    expect(onDecide).toHaveBeenCalledWith({ type: 'confirm-save' });
  });

  it('recovers after a mismatch: editing to the correct name then saves', async () => {
    const onDecide = vi.fn();
    const { stdin } = await mountReady(writableInput, onDecide);
    stdin.write(ENTER); // open gate
    await tick();
    stdin.write('relx'); // wrong
    await tick();
    stdin.write(ENTER); // mismatch (recoverable)
    await tick();
    stdin.write(BACKSPACE); // backspace the 'x'
    await tick();
    stdin.write('eases-bot'); // -> 'releases-bot'
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onDecide).toHaveBeenCalledWith({ type: 'confirm-save' });
  });
});

describe('ReviewScreen — the default action is the safe cancel', () => {
  it('cancels on esc from the browse view', async () => {
    const onDecide = vi.fn();
    const { stdin } = await mountReady(writableInput, onDecide);
    stdin.write(ESC);
    await tick();
    expect(onDecide).toHaveBeenCalledWith({ type: 'cancel' });
  });

  it('esc inside the gate backs out to the audit without saving', async () => {
    const onDecide = vi.fn();
    const { stdin, lastFrame } = await mountReady(writableInput, onDecide);
    stdin.write(ENTER); // open gate
    await tick();
    stdin.write(ESC); // esc out of the gate
    await tick();
    expect(onDecide).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('type-to-save');
  });
});
