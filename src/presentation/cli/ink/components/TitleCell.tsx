// The one definition of row-title layout: a fixed-width, emoji-normalised, truncating cell, so
// whatever sits to its right — the access token — lines up down any list.
import type { FC } from 'react';
import { Box, Text } from 'ink';

import { PICKER_LAYOUT } from '../layout.js';
import { colorProps, toAlignableTitle, type ColorToken } from '../theme.js';

export interface TitleCellProps {
  readonly text: string;
  readonly color: ColorToken;
}

export const TitleCell: FC<TitleCellProps> = ({ text, color }) => (
  <Box width={PICKER_LAYOUT.titleColumns} flexShrink={0}>
    <Text {...colorProps(color)} wrap="truncate-end">
      {toAlignableTitle(text)}
    </Text>
  </Box>
);
