/**
 * Footer — the context-sensitive key hint bar, auto-generated from the binding table: it shows
 * exactly the bindings enabled for the current state (e.g. r/w vanish while the search box is
 * focused), in table order, so the hints can never drift from what the keys actually do.
 */
import type { FC } from 'react';
import { Box, Text } from 'ink';

import { formatBindingHint, selectFooterBindings } from '../bindings.js';
import { colorProps, defaultTheme, type Theme } from '../theme.js';
import type { FooterProps } from './index.js';

export const Footer: FC<FooterProps & { readonly theme?: Theme }> = ({
  bindings,
  state,
  theme = defaultTheme,
}) => {
  const shown = selectFooterBindings(state, bindings);
  return (
    <Box flexWrap="wrap">
      {shown.map((binding, index) => (
        <Box key={binding.id}>
          {index > 0 ? <Text {...colorProps(theme.color.inherited)}>{' · '}</Text> : null}
          <Text {...colorProps(theme.color.cursor)}>{formatBindingHint(binding)}</Text>
          <Text>{` ${binding.label}`}</Text>
        </Box>
      ))}
    </Box>
  );
};
