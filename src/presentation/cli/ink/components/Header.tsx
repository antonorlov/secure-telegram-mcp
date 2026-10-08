// A pure projection of `HeaderProps`. The writable count is the ONE figure that warns, because
// write is the only escalation.
import type { FC } from 'react';
import { Box, Text } from 'ink';

import { colorProps, defaultTheme, type Theme } from '../theme.js';
import type { HeaderProps } from './index.js';

export const Header: FC<HeaderProps & { readonly theme?: Theme }> = ({
  endpointName,
  inScopeCount,
  writableCount,
  shown,
  total,
  theme = defaultTheme,
}) => (
  <Box justifyContent="space-between">
    <Box>
      <Text {...colorProps(theme.color.title)} bold>
        {`Endpoint: "${endpointName}"`}
      </Text>
      <Text>{`  ${String(inScopeCount)} in scope · `}</Text>
      <Text {...colorProps(writableCount > 0 ? theme.color.write : undefined)}>
        {`${String(writableCount)} writable`}
      </Text>
    </Box>
    <Text {...colorProps(theme.color.inherited)}>
      {`${String(shown)}/${String(total)} shown`}
    </Text>
  </Box>
);
