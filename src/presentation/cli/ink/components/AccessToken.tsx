/**
 * AccessToken — the one definition of the access read-out: the minimal, colour-coded `r` / `w`
 * / `rw` token in a fixed cell a gap to the right of a {@link TitleCell}, shared by the picker
 * rows and the review matrix. Green = read-only (safe), bold amber = writable (the escalation);
 * nothing for a non-member.
 *
 * Pure projection of an already-resolved {@link EffectiveAccess}; owns no ACL logic.
 */
import type { FC } from 'react';
import { Box, Text } from 'ink';

import { PICKER_LAYOUT } from '../layout.js';
import {
  accessColor,
  colorProps,
  defaultTheme,
  formatAccessToken,
  type Theme,
} from '../theme.js';
import type { EffectiveAccess } from '../../picker/index.js';

export interface AccessTokenProps {
  readonly effective: EffectiveAccess;
}

export const AccessToken: FC<AccessTokenProps & { readonly theme?: Theme }> = ({
  effective,
  theme = defaultTheme,
}) => {
  const token = formatAccessToken(effective);
  if (token === '') {
    return null;
  }
  return (
    <Box
      marginLeft={PICKER_LAYOUT.titleGapColumns}
      width={PICKER_LAYOUT.accessTokenColumns}
      flexShrink={0}
    >
      <Text
        {...colorProps(accessColor(effective, theme))}
        bold={effective.bits.write}
      >
        {token}
      </Text>
    </Box>
  );
};
