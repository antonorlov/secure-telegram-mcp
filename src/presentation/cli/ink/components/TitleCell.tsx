/**
 * TitleCell — the one definition of "how a row title is laid out": a fixed-width,
 * emoji-normalised, truncating cell, so whatever sits to its right (the r/w access token) lines
 * up down any list — the picker rows and the review matrix. Emoji/flag runs are normalised
 * (their width disagrees between `string-width` and real terminals) so the measured width
 * matches what is drawn.
 *
 * Pure presentation: it renders the text it is given and owns no domain logic.
 */
import type { FC } from 'react';
import { Box, Text } from 'ink';

import { PICKER_LAYOUT } from '../layout.js';
import { colorProps, toAlignableTitle, type ColorToken } from '../theme.js';

export interface TitleCellProps {
  readonly text: string;
  /** Foreground token (cursor accent / dim); `undefined` -> terminal default. */
  readonly color: ColorToken;
}

export const TitleCell: FC<TitleCellProps> = ({ text, color }) => (
  <Box width={PICKER_LAYOUT.titleColumns} flexShrink={0}>
    <Text {...colorProps(color)} wrap="truncate-end">
      {toAlignableTitle(text)}
    </Text>
  </Box>
);
