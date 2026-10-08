/**
 * One rendered list row: a chat, or the pinned "whole folder as a unit" row at the top of a
 * folder tab. A pure projection of already-derived read-outs — `effective` and `triState` come
 * from the reducer selectors, never from here.
 */
import type { FC } from 'react';
import { Box, Text } from 'ink';

import {
  formatBitsToken,
  bitsColor,
  accessColor,
  colorProps,
  defaultTheme,
  KIND_GLYPH,
  memberGlyph,
  triStateGlyph,
  type ColorToken,
  type Theme,
} from '../theme.js';
import { AccessToken } from './AccessToken.js';
import { TitleCell } from './TitleCell.js';
import type { TreeRowProps } from './index.js';

export const TreeRow: FC<TreeRowProps & { readonly theme?: Theme }> = ({
  row,
  isCursor,
  inVisualRange,
  effective,
  triState,
  folderSummary,
  folderBits,
  theme = defaultTheme,
}) => {
  const g = theme.glyph;
  const gutter = isCursor ? g.cursor : g.noCursor;
  const accent: ColorToken = isCursor
    ? theme.color.cursor
    : inVisualRange
      ? theme.color.match
      : undefined;

  if (row.kind === 'folder') {
    const check = triStateGlyph(triState ?? 'none', g);
    const body = folderSummary ?? `Entire "${row.title}" folder`;
    const token = folderBits === undefined ? undefined : formatBitsToken(folderBits);
    const tint =
      folderBits === undefined ? theme.color.folder : bitsColor(folderBits, theme);
    return (
      <Box>
        <Text {...colorProps(accent)}>{`${gutter} `}</Text>
        <Text {...colorProps(tint)} bold={isCursor}>{`${check} ${body}`}</Text>
        {token !== undefined ? (
          <Text {...colorProps(tint)} bold={token === 'rw'}>{`  ${token}`}</Text>
        ) : null}
      </Box>
    );
  }

  const isMember = effective?.member === true;
  const tint = accessColor(effective, theme);
  const handle = row.username !== undefined ? ` @${row.username}` : '';
  const alsoIn =
    row.folderTitles.length > 1 ? `  (also in: ${row.folderTitles.join(', ')})` : '';

  return (
    <Box>
      <Text {...colorProps(accent)}>{`${gutter} `}</Text>
      <Text {...colorProps(isMember ? tint : accent)}>
        {`${memberGlyph(isMember, g)} `}
      </Text>
      <TitleCell
        text={`${KIND_GLYPH[row.chatKind]} ${row.title}${handle}`}
        color={accent}
      />
      {effective?.member === true ? (
        <AccessToken effective={effective} theme={theme} />
      ) : null}
      {alsoIn !== '' ? (
        <Text {...colorProps(theme.color.inherited)}>{alsoIn}</Text>
      ) : null}
    </Box>
  );
};
