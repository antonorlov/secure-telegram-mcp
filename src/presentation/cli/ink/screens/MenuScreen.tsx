/**
 * MenuScreen — the one reusable arrow-key select screen. Every wizard-shell choice menu (main
 * menu, login method, session-security) is a projection of a `MenuRequest` through this single
 * component.
 *
 * A thin render+input adapter: the cursor math is the framework-free, unit-tested
 * `moveMenuIndex`; the visuals reuse the shared `theme`. It owns no business state — it raises
 * the operator's choice (or a cancel) through `onDone`.
 *
 * Keys: up/down + k/j move (wrap-around), Enter selects, and Esc / ← (Left) / h / q go back
 * (cancel) — the default safe action, which the caller maps onto back / quit / abort.
 */
import { useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';

import { colorProps, defaultTheme, type Theme } from '../theme.js';
import type { MenuRequest, MenuResult } from '../ui-port.js';

/**
 * Pure cursor navigation: move one step in `direction` within `[0, count)`, wrapping at both
 * ends (down from the last row returns to the first). Total and framework-free so the wrap
 * contract is pinned by a unit test. A `count` of zero (a degenerate empty menu) clamps to 0.
 */
export const moveMenuIndex = (
  current: number,
  direction: 'up' | 'down',
  count: number,
): number => {
  if (count <= 0) return 0;
  const delta = direction === 'up' ? -1 : 1;
  return (current + delta + count) % count;
};

/** The render-time props: the request to render + the outcome seam + a theme override. */
export interface MenuScreenProps<T> {
  readonly request: MenuRequest<T>;
  readonly onDone: (result: MenuResult<T>) => void;
  readonly theme?: Theme;
}

export function MenuScreen<T>({
  request,
  onDone,
  theme = defaultTheme,
}: MenuScreenProps<T>): ReactElement {
  const { title, subtitle, options } = request;
  const [index, setIndex] = useState(0);

  useInput((char, key) => {
    // Esc / ← / h / q = the safe default back (the caller maps it to back / quit).
    if (key.escape || key.leftArrow || char === 'q' || char === 'h') {
      onDone({ kind: 'cancelled' });
      return;
    }
    if (key.upArrow || char === 'k') {
      setIndex((i) => moveMenuIndex(i, 'up', options.length));
      return;
    }
    if (key.downArrow || char === 'j') {
      setIndex((i) => moveMenuIndex(i, 'down', options.length));
      return;
    }
    if (key.return) {
      const chosen = options[index];
      if (chosen !== undefined) {
        onDone({ kind: 'selected', value: chosen.value });
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Text {...colorProps(theme.color.title)} bold>
        {title}
      </Text>
      {subtitle !== undefined ? (
        <Text {...colorProps(theme.color.inherited)}>{subtitle}</Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, i) => {
          const isCursor = i === index;
          const caret = isCursor ? theme.glyph.cursor : theme.glyph.noCursor;
          return (
            // The option list is static per mount, so the row index is a stable key (and,
            // unlike the label, is robust to duplicate labels).
            <Box key={i}>
              <Text {...colorProps(isCursor ? theme.color.cursor : undefined)}>
                {`${caret} ${option.label}`}
              </Text>
              {option.hint !== undefined ? (
                <Text {...colorProps(theme.color.inherited)}>{`  — ${option.hint}`}</Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text {...colorProps(theme.color.inherited)}>
          {'up/down·k/j move · enter select · esc/← back'}
        </Text>
      </Box>
    </Box>
  );
}
