/**
 * PromptFrame — the chrome shared by every single-line input wrapper (LinePrompt /
 * ConfirmPrompt), so the title / subtitle / recoverable-error / key-hint
 * layout is defined once. The wrappers supply only the actual `@inkjs/ui` field as `children`;
 * this frame never touches input.
 *
 * Ink `Box`/`Text` only; colours come from the shared `theme` (NO_COLOR-safe). It holds no
 * state and raises no events.
 */
import type { FC, ReactNode } from 'react';
import { Box, Text } from 'ink';

import { colorProps, defaultTheme, type Theme } from '../theme.js';
import { ClassifiedLine } from '../components/index.js';

export interface PromptFrameProps {
  readonly title: string;
  readonly subtitle?: string;
  /** Persistent full-contrast context lines shown above the field while typing. */
  readonly help?: readonly string[];
  /** A recoverable validation error shown under the field (stays open on error). */
  readonly error?: string;
  /** The key-hint line (e.g. "enter submit · esc cancel"). */
  readonly hint: string;
  /** The actual input field (a thin `@inkjs/ui` wrapper). */
  readonly children: ReactNode;
  readonly theme?: Theme;
}

export const PromptFrame: FC<PromptFrameProps> = ({
  title,
  subtitle,
  help,
  error,
  hint,
  children,
  theme = defaultTheme,
}) => (
  <Box flexDirection="column">
    {/* Context BEFORE the question: the field name must sit adjacent to the
        input it labels, never separated from it by a paragraph of guidance. */}
    {help !== undefined && help.length > 0 ? (
      <Box flexDirection="column" marginBottom={1}>
        {help.map((line, i) => (
          // Help speaks the notice convention: asides dim, URLs underlined accents,
          // commands and payloads as in NoticeScreen.
          <ClassifiedLine key={i} text={line} theme={theme} />
        ))}
      </Box>
    ) : null}
    <Text {...colorProps(theme.color.title)} bold>
      {title}
    </Text>
    {subtitle !== undefined ? (
      <Text {...colorProps(theme.color.inherited)}>{subtitle}</Text>
    ) : null}
    <Box>
      <Text {...colorProps(theme.color.cursor)}>{'> '}</Text>
      {children}
    </Box>
    {error !== undefined ? (
      <Text {...colorProps(theme.color.error)}>{error}</Text>
    ) : null}
    <Box marginTop={1}>
      <Text {...colorProps(theme.color.inherited)}>{hint}</Text>
    </Box>
  </Box>
);
