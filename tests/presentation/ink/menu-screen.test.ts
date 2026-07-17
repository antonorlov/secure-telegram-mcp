/**
 * MenuScreen tests — the ONE reusable arrow-nav SELECT screen. Two layers:
 *
 *   1. `moveMenuIndex` (PURE): the wrap-around cursor contract, pinned without Ink.
 *   2. The component (ink-testing-library, NO_COLOR theme): render smoke (title,
 *      subtitle, options, hints, cursor caret) + the input contract — up/down and
 *      k/j move with wrap, Enter selects the cursor's VALUE, Esc/q cancel (the safe
 *      default). It holds no state beyond the cursor and raises `onDone`.
 *
 * Input is asynchronous (Ink parses keypresses + React flushes on ticks), so each
 * interaction is awaited before asserting. JSX-free (React.createElement) so this
 * stays a `.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { render } from 'ink-testing-library';

import {
  MenuScreen,
  moveMenuIndex,
  type MenuScreenProps,
} from '../../../src/presentation/cli/ink/screens/MenuScreen.js';
import { createTheme } from '../../../src/presentation/cli/ink/theme.js';
import type {
  MenuRequest,
  MenuResult,
} from '../../../src/presentation/cli/ink/ui-port.js';

const mono = createTheme({ colorsEnabled: false, unicodeGlyphs: false });

const ESC = '\x1B';
const ENTER = '\r';
const ARROW_UP = '\x1B[A';
const ARROW_DOWN = '\x1B[B';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

type Choice = 'login' | 'security' | 'quit';

const request: MenuRequest<Choice> = {
  title: 'secure-telegram-mcp setup',
  subtitle: 'Main menu',
  options: [
    { value: 'login', label: 'Login & configure', hint: 'log in and edit endpoints' },
    { value: 'security', label: 'Session security' },
    { value: 'quit', label: 'Quit', hint: 'exit setup' },
  ],
};

const mount = (
  onDone: (r: MenuResult<Choice>) => void,
): ReturnType<typeof render> =>
  render(
    createElement(MenuScreen<Choice>, {
      request,
      onDone,
      theme: mono,
    } satisfies MenuScreenProps<Choice>),
  );

const mountReady = async (
  onDone: (r: MenuResult<Choice>) => void,
): Promise<ReturnType<typeof render>> => {
  const harness = mount(onDone);
  await tick();
  return harness;
};

// ---------------------------------------------------------------------------
// 1) Pure cursor navigation (wrap-around).
// ---------------------------------------------------------------------------

describe('moveMenuIndex — wrap-around cursor', () => {
  it('moves down and wraps from the last row to the first', () => {
    expect(moveMenuIndex(0, 'down', 3)).toBe(1);
    expect(moveMenuIndex(1, 'down', 3)).toBe(2);
    expect(moveMenuIndex(2, 'down', 3)).toBe(0);
  });

  it('moves up and wraps from the first row to the last', () => {
    expect(moveMenuIndex(2, 'up', 3)).toBe(1);
    expect(moveMenuIndex(1, 'up', 3)).toBe(0);
    expect(moveMenuIndex(0, 'up', 3)).toBe(2);
  });

  it('clamps a degenerate empty menu to 0', () => {
    expect(moveMenuIndex(0, 'down', 0)).toBe(0);
    expect(moveMenuIndex(0, 'up', 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2) Render smoke.
// ---------------------------------------------------------------------------

describe('MenuScreen — render', () => {
  it('renders the title, subtitle, options, hints, and the cursor on the first row', () => {
    const { lastFrame } = mount(vi.fn());
    const frame = lastFrame() ?? '';
    expect(frame).toContain('secure-telegram-mcp setup');
    expect(frame).toContain('Main menu');
    expect(frame).toContain('Login & configure');
    expect(frame).toContain('Session security');
    expect(frame).toContain('Quit');
    expect(frame).toContain('log in and edit endpoints');
    // The cursor caret ('>') sits on the first option by default.
    expect(frame).toContain('> Login & configure');
    expect(frame).toContain('esc/← back');
  });
});

// ---------------------------------------------------------------------------
// 3) Input contract.
// ---------------------------------------------------------------------------

describe('MenuScreen — selection', () => {
  it('Enter selects the cursor row (first option by default)', async () => {
    const onDone = vi.fn();
    const { stdin } = await mountReady(onDone);
    stdin.write(ENTER);
    await tick();
    expect(onDone).toHaveBeenCalledWith({ kind: 'selected', value: 'login' });
  });

  it('arrow-down then Enter selects the second option', async () => {
    const onDone = vi.fn();
    const { stdin } = await mountReady(onDone);
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onDone).toHaveBeenCalledWith({ kind: 'selected', value: 'security' });
  });

  it('j/k vi-nav moves the cursor', async () => {
    const onDone = vi.fn();
    const { stdin } = await mountReady(onDone);
    stdin.write('j'); // -> security
    await tick();
    stdin.write('j'); // -> quit
    await tick();
    stdin.write('k'); // -> security
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onDone).toHaveBeenCalledWith({ kind: 'selected', value: 'security' });
  });

  it('arrow-up from the first row WRAPS to the last, then Enter selects it', async () => {
    const onDone = vi.fn();
    const { stdin } = await mountReady(onDone);
    stdin.write(ARROW_UP);
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onDone).toHaveBeenCalledWith({ kind: 'selected', value: 'quit' });
  });
});

describe('MenuScreen — cancel is the safe default', () => {
  it('Esc cancels without selecting', async () => {
    const onDone = vi.fn();
    const { stdin } = await mountReady(onDone);
    stdin.write(ESC);
    await tick();
    expect(onDone).toHaveBeenCalledWith({ kind: 'cancelled' });
  });

  it('q cancels without selecting', async () => {
    const onDone = vi.fn();
    const { stdin } = await mountReady(onDone);
    stdin.write('q');
    await tick();
    expect(onDone).toHaveBeenCalledWith({ kind: 'cancelled' });
  });
});
