/**
 * SearchInput — the live fuzzy-filter box. When focused it shows a caret and is
 * accent-coloured; the match count mirrors the header's "shown" tally. Focus is
 * load-bearing elsewhere (it makes the r/w access grants inert), but here it only
 * drives the caret + colour.
 */
import type { FC } from 'react';
import { Box, Text } from 'ink';

import { colorProps, defaultTheme, type Theme } from '../theme.js';
import type { SearchInputProps } from './index.js';

export const SearchInput: FC<SearchInputProps & { readonly theme?: Theme }> = ({
  query,
  focused,
  matchCount,
  theme = defaultTheme,
}) => {
  const caret = focused ? '_' : '';
  return (
    <Box justifyContent="space-between">
      <Box>
        <Text {...colorProps(focused ? theme.color.match : theme.color.inherited)}>
          {'search | '}
        </Text>
        <Text>{`${query}${caret}`}</Text>
      </Box>
      <Text {...colorProps(theme.color.inherited)}>
        {`${String(matchCount)} match${matchCount === 1 ? '' : 'es'}`}
      </Text>
    </Box>
  );
};
