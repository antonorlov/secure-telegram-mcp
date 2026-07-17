/**
 * TreeRow — one rendered list row: a chat, or the pinned "whole folder as a unit" row shown at
 * the top of a folder tab. A pure projection of already-derived read-outs
 * (`effective`/`triState` come from the reducer selectors, never here).
 *
 * Colour encodes access at a glance: a member is tinted green when read-only and amber (bold)
 * when writable — the escalation warning — while a non-member stays dim. Colour only reinforces
 * the `r`/`rw` text token and collapses to the terminal default under NO_COLOR. The cursor /
 * visual-range accents never change access.
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

  // --- the pinned "whole folder as a unit" row (top of a folder tab) ----------
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

  // --- a chat leaf row --------------------------------------------------------
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
