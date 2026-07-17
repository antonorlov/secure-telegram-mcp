/**
 * NoticeScreen — the dedicated must-read screen: a bold title, the body rendered on its own
 * un-truncated screen (so a HARDENED PIN-file block or a shown-once API key stays intact
 * and copyable), then a dim acknowledge hint. Body lines are tinted line-by-line via
 * `classifyNoticeLine` — commands accent, asides dim, prose full-contrast.
 *
 * The block lives in the live region, so pressing Enter unmounts it and the flow continues on
 * a clean screen — it does not linger stacked above the next menu. (Not Ink `<Static>`, which
 * commits output permanently and would pile every must-read above later screens.)
 *
 * It blocks: it raises a single acknowledgment through `onDone` when the operator presses
 * Enter — that is what makes `ui.notice(...)` awaitable, guaranteeing the operator saw the
 * block before the flow moves on.
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

  // Title (bold), a blank spacer row, then the body — all in the live region, so the
  // whole block is wiped the moment this screen is dismissed. Body indices are stable
  // keys: the body is static per mount (same rationale as MenuScreen's option rows).
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
