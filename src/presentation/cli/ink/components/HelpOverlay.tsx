/**
 * HelpOverlay — the grouped `?` cheat-sheet. Rendered from the binding table (same source as
 * dispatch + footer), bucketed by help group in a fixed order, so it documents the entire
 * keymap with zero hand-maintained drift.
 */
import type { FC } from 'react';
import { Box, Text } from 'ink';

import { formatBindingHint, groupBindingsForHelp } from '../bindings.js';
import { borderColorProps, colorProps, defaultTheme, type Theme } from '../theme.js';
import type { HelpOverlayProps } from './index.js';

const GROUP_TITLE: Readonly<Record<string, string>> = Object.freeze({
  move: 'Move',
  tabs: 'Tabs',
  select: 'Select',
  access: 'Access',
  search: 'Search',
  meta: 'Meta',
});

export const HelpOverlay: FC<HelpOverlayProps & { readonly theme?: Theme }> = ({
  bindings,
  theme = defaultTheme,
}) => (
  // alignSelf keeps the border hugging the content instead of stretching to the
  // terminal edge; groups flow as wrapping columns so the sheet stays compact on
  // wide terminals and degrades to the old vertical stack on narrow ones.
  <Box
    flexDirection="column"
    borderStyle="round"
    {...borderColorProps(theme.color.frame)}
    paddingX={2}
    alignSelf="flex-start"
  >
    <Text {...colorProps(theme.color.title)} bold>
      {'Keys'}
    </Text>
    <Box flexWrap="wrap" columnGap={4} rowGap={1} marginTop={1}>
      {groupBindingsForHelp(bindings).map(({ group, bindings: groupBindings }) => {
        // Per-group key column: as wide as the group's longest hint, +2 gutter.
        const keyWidth =
          Math.max(...groupBindings.map((b) => formatBindingHint(b).length)) + 2;
        return (
          <Box key={group} flexDirection="column">
            <Text {...colorProps(theme.color.folder)} bold>
              {GROUP_TITLE[group] ?? group}
            </Text>
            {groupBindings.map((binding) => (
              <Box key={binding.id}>
                <Text {...colorProps(theme.color.cursor)}>
                  {formatBindingHint(binding).padEnd(keyWidth)}
                </Text>
                <Text>{binding.label}</Text>
              </Box>
            ))}
          </Box>
        );
      })}
    </Box>
  </Box>
);
