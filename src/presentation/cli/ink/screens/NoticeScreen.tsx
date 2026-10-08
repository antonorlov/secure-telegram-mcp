/**
 * The dedicated must-read screen: a bold title, the body rendered un-truncated on its own
 * screen — so a HARDENED PIN-file block or a shown-once API key stays intact and copyable —
 * then a dim acknowledge hint.
 */
import { type FC } from 'react';
import { Box, Text, useInput } from 'ink';

import { colorProps, defaultTheme } from '../theme.js';
import { ClassifiedLine } from '../components/index.js';
import type { NoticeRequest } from '../setup-ui-port.js';

export const NoticeScreen: FC<{
  readonly request: NoticeRequest;
  readonly onDone: () => void;
}> = ({ request, onDone }) => {
  useInput((_char, key) => {
    if (key.return) {
      onDone();
    }
  });

  // Title, spacer and body all sit in the live region, so the whole block is wiped the moment
  // this screen is dismissed. Body indices are stable keys: the body is static per mount.
  return (
    <Box flexDirection="column">
      <Text {...colorProps(defaultTheme.color.title)} bold>
        {request.title}
      </Text>
      {/* Line-level tinting only, never wrap="truncate": every block stays intact
          and copyable (the finder-square/API-key truncation guard). */}
      <Box flexDirection="column" marginTop={1}>
        {request.body.map((text, i) => (
          <ClassifiedLine key={i} text={text} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{'Press Enter to continue'}</Text>
      </Box>
    </Box>
  );
};
