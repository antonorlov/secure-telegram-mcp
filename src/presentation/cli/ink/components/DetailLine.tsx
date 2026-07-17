/**
 * DetailLine — the in-process detail read-out for the cursor row (kind, handle,
 * and which folders a chat appears under). The text is assembled by the screen;
 * this component only frames it.
 */
import type { FC } from 'react';
import { Box, Text } from 'ink';

import { colorProps, defaultTheme, type Theme } from '../theme.js';
import type { DetailLineProps } from './index.js';

export const DetailLine: FC<DetailLineProps & { readonly theme?: Theme }> = ({
  text,
  theme = defaultTheme,
}) => (
  <Box>
    <Text {...colorProps(theme.color.inherited)}>{'detail: '}</Text>
    <Text>{text}</Text>
  </Box>
);
