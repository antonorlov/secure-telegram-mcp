/**
 * ClassifiedLine — one notice/help body line rendered per `classifyNoticeLine`:
 * payloads bold, commands accent with dimmed comments, asides dim, URLs accent +
 * underline, prose plain. Shared by NoticeScreen bodies and PromptFrame help so the
 * two surfaces speak one convention.
 */
import type { FC } from 'react';
import { Text } from 'ink';

import { classifyNoticeLine, colorProps, defaultTheme, type Theme } from '../theme.js';

export const ClassifiedLine: FC<{ readonly text: string; readonly theme?: Theme }> = ({
  text,
  theme = defaultTheme,
}) => {
  const style = classifyNoticeLine(text);
  switch (style.kind) {
    case 'payload':
      // The deliverable: maximum emphasis, deliberately hue-free — bold survives
      // NO_COLOR and never reads as command/warning/safe semantics.
      return <Text bold>{text}</Text>;
    case 'command':
      return (
        <Text>
          <Text {...colorProps(theme.color.cursor)}>{style.command}</Text>
          {style.comment !== undefined ? (
            <Text {...colorProps(theme.color.inherited)}>{style.comment}</Text>
          ) : null}
        </Text>
      );
    case 'aside':
      return <Text {...colorProps(theme.color.inherited)}>{text}</Text>;
    case 'link':
      return (
        <Text>
          {style.before}
          <Text {...colorProps(theme.color.cursor)} underline>
            {style.url}
          </Text>
          {style.after}
        </Text>
      );
    case 'text':
      return <Text>{text}</Text>;
  }
};
