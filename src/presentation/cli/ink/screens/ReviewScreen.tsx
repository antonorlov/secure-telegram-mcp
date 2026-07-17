/**
 * ReviewScreen — the security-first gate before an endpoint is written. A thin render+input
 * adapter: every figure it shows (the resolved access matrix, the diff, the inverse
 * blast-radius audit) is pre-computed upstream and handed in via `ReviewInput`; this
 * component holds no ACL/resolution logic, it only projects those read-outs and collects the
 * operator's decision.
 *
 * The screen raises its outcome through `onDecide`. The default action is the safe cancel:
 * saving an endpoint that would expose any writable chat requires the operator to type the
 * endpoint name (the one escalation prompt — navigation/reading never prompt). A name
 * mismatch is a recoverable validation error: the prompt stays open so the operator can retry.
 *
 * Ink/React live only in this presentation module; reached exclusively on the lazy wizard
 * path, never by `connect`.
 */
import { useState, type FC } from 'react';
import { Box, Text, useInput } from 'ink';

import { colorProps, defaultTheme, type Theme } from '../theme.js';
import { AccessToken, TitleCell } from '../components/index.js';
import type { EffectiveAccess } from '../../picker/index.js';
import type { ReviewDecision, ReviewInput, ReviewMatrixRow } from '../ui-port.js';

/**
 * The Review screen's render-time props: the resolved matrix/diff/blast-radius (`input`)
 * plus the `onDecide` outcome seam (the Ink adapter resolves its `ReviewUi.present` promise
 * from this callback) and an optional theme override for deterministic render-tests.
 */
export interface ReviewScreenViewProps {
  readonly input: ReviewInput;
  readonly onDecide: (decision: ReviewDecision) => void;
  readonly theme?: Theme;
}

/** Local UI phase: browse the audit, or type the name to confirm a writable save. */
type ReviewPhase = 'browse' | 'confirm';

/** The resolved-access value the shared {@link AccessToken} projects for a row. */
const rowEffective = (row: ReviewMatrixRow): EffectiveAccess => ({
  member: true, // the matrix lists in-scope chats only
  bits: row.bits,
});

export const ReviewScreen: FC<ReviewScreenViewProps> = ({
  input,
  onDecide,
  theme = defaultTheme,
}) => {
  const { endpointName, matrix, diff, blastRadius, hasWritable } = input;
  const [phase, setPhase] = useState<ReviewPhase>('browse');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  useInput((char, key) => {
    if (phase === 'browse') {
      // Esc / q = the safe default (cancel, no write). Navigation never prompts.
      if (key.escape || char === 'q') {
        onDecide({ type: 'cancel' });
        return;
      }
      // Enter / s = save. Write is the only escalation: gate it behind the name.
      if (key.return || char === 's') {
        if (hasWritable) {
          setPhase('confirm');
          setTyped('');
          setError(undefined);
        } else {
          onDecide({ type: 'confirm-save' });
        }
      }
      return;
    }

    // --- confirm phase: type the endpoint name (recoverable on mismatch) ---
    if (key.escape) {
      // Back out of the gate to the audit (Esc precedence: close overlay first).
      setPhase('browse');
      setTyped('');
      setError(undefined);
      return;
    }
    if (key.return) {
      if (typed === endpointName) {
        onDecide({ type: 'confirm-save' });
      } else {
        setError(`Name does not match "${endpointName}" — save aborted, try again.`);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setTyped((prev) => prev.slice(0, -1));
      setError(undefined);
      return;
    }
    if (char.length > 0 && !key.ctrl && !key.meta) {
      setTyped((prev) => prev + char);
      setError(undefined);
    }
  });

  const writableCount = matrix.filter((row) => row.bits.write).length;

  return (
    <Box flexDirection="column">
      <Text {...colorProps(theme.color.title)} bold>
        {`Review — "${endpointName}"`}
      </Text>

      {/* --- resolved access matrix: title + colour-coded r/rw token per chat --- */}
      <Box marginTop={1}>
        <Text {...colorProps(theme.color.inherited)}>
          {`Resolved access · ${String(matrix.length)} in scope · ${String(writableCount)} writable`}
        </Text>
      </Box>
      {/* Legend so a first-timer reads the terse token (the picker footer echoes it). */}
      <Text {...colorProps(theme.color.inherited)}>
        {'  (r = read · rw = read + write)'}
      </Text>
      {/* One-line consent read-out of exactly what the write bit unlocks (edit rides
          on send, which also backs edit_message). */}
      <Text {...colorProps(theme.color.inherited)}>
        {'  write = send · edit · delete · forward · draft · mark_read · react'}
      </Text>
      {matrix.length === 0 ? (
        <Text {...colorProps(theme.color.inherited)}>{'  (no chats in scope)'}</Text>
      ) : (
        matrix.map((row) => (
          // Same aligned cells as the picker list: fixed-width title, then the colour-coded
          // r/w/rw token. No separate verbs column — the token is the access read-out.
          <Box key={row.title}>
            <Text>{'  '}</Text>
            <TitleCell text={row.title} color={undefined} />
            <AccessToken effective={rowEffective(row)} theme={theme} />
          </Box>
        ))
      )}

      {/* --- diff vs. on-disk config --- */}
      <Box marginTop={1}>
        <Text {...colorProps(theme.color.title)} bold>
          {'Changes'}
        </Text>
      </Box>
      {diff.length === 0 ? (
        <Text {...colorProps(theme.color.inherited)}>{'  (no changes vs. saved config)'}</Text>
      ) : (
        diff.map((line) => (
          <Text key={line}>{`  ${line}`}</Text>
        ))
      )}

      {/* --- inverse blast-radius audit ("what is exposed where") --- */}
      <Box marginTop={1}>
        <Text {...colorProps(hasWritable ? theme.color.write : theme.color.title)} bold>
          {'Write blast radius'}
        </Text>
      </Box>
      {blastRadius.length === 0 ? (
        <Text {...colorProps(theme.color.inherited)}>{'  (nothing becomes writable)'}</Text>
      ) : (
        blastRadius.map((entry) => (
          <Box key={entry.title}>
            <Text {...colorProps(theme.color.write)}>{`  ${entry.title}`}</Text>
            <Text {...colorProps(theme.color.inherited)}>
              {`  writable from: ${entry.writableFromEndpoints.join(', ')}`}
            </Text>
          </Box>
        ))
      )}

      {/* --- decision / typed-name gate --- */}
      {phase === 'confirm' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text {...colorProps(theme.color.write)} bold>
            {`This exposes WRITE. Type "${endpointName}" to confirm save:`}
          </Text>
          <Box>
            <Text {...colorProps(theme.color.cursor)}>{'  > '}</Text>
            <Text>{`${typed}_`}</Text>
          </Box>
          {error !== undefined ? (
            <Text {...colorProps(theme.color.error)}>{`  ${error}`}</Text>
          ) : null}
          <Text {...colorProps(theme.color.inherited)}>
            {'  enter confirm · esc cancel (default: cancel)'}
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text {...colorProps(theme.color.inherited)}>
            {hasWritable
              ? 'enter/s type-to-save · esc/q cancel (default: cancel)'
              : 'enter/s save · esc/q cancel (default: cancel)'}
          </Text>
        </Box>
      )}
    </Box>
  );
};
