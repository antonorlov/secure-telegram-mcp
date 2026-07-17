/**
 * PickerScreen — the hard step rendered as a Telegram-style tabbed picker: a horizontal
 * folder-tab strip (`All chats` + one tab per folder) over a windowed chat list. Only the
 * rows that fit the terminal render; the list scrolls internally (with `↑ N` / `↓ N`
 * indicators) while the chrome — tabs, search, footer — stays put. Access is colour-coded:
 * green `r` (read-only, safe) vs bold amber `rw` (writable, the escalation warning); a
 * non-member shows no token.
 *
 * A thin render+input adapter: a pure projection of the reducer `PickerState` through the
 * framework-free selectors (`selectWindow`, `selectTabs`, `resolveEffective`, …). It owns no
 * domain/selection state — the parent owns the reducer; the only local state is the `?`
 * overlay toggle and the measured terminal height (fed back as `setViewportRows`).
 *
 * The three axes are kept apart at the input seam: when the search box is focused the tab
 * keymap is inactive and the keyboard is a plain text field, so typing a chat's name can
 * never grant write. Esc walks the single precedence ladder (clear-filter -> close-overlay ->
 * ascend).
 */
import type { FC } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout, type Key } from 'ink';

import {
  DetailLine,
  Footer,
  Header,
  HelpOverlay,
  SearchInput,
  TabBar,
  TreeRow,
  type KeyBinding,
  type TreeRowProps,
} from '../components/index.js';
import { defaultPickerBindings, MetaBindingId } from '../bindings.js';
import { PICKER_LAYOUT } from '../layout.js';
import { useKeyBindings } from '../use-key-bindings.js';
import {
  colorProps,
  defaultTheme,
  KIND_GLYPH,
  type Theme,
} from '../theme.js';
import {
  deriveFolderTriState,
  resolveEffective,
  selectFolderCounts,
  selectShownCounts,
  selectTabs,
  selectVisibleRows,
  selectWindow,
  uniformFolderBits,
  uniqueChatKeys,
  type PickerAction,
  type PickerState,
  type Row,
  type RowId,
} from '../../picker/index.js';

/** The header tallies: how many chats are in scope (across ALL tabs) and writable. */
export const computeHeaderCounts = (
  state: PickerState,
): { readonly inScope: number; readonly writable: number } => {
  let inScope = 0;
  let writable = 0;
  for (const key of uniqueChatKeys(state.rows)) {
    const eff = resolveEffective(state, key);
    if (eff.member) {
      inScope += 1;
      if (eff.bits.write) writable += 1;
    }
  }
  return { inScope, writable };
};

/** The row ids inside the visual range [anchor..cursor] within the VISIBLE list. */
const visualRangeIds = (
  visible: readonly Row[],
  anchorId: RowId | undefined,
  cursorId: RowId | undefined,
): ReadonlySet<RowId> => {
  if (anchorId === undefined || cursorId === undefined) return new Set();
  const a = visible.findIndex((r) => r.id === anchorId);
  const c = visible.findIndex((r) => r.id === cursorId);
  if (a === -1 || c === -1) return new Set();
  const lo = Math.min(a, c);
  const hi = Math.max(a, c);
  const ids = new Set<RowId>();
  for (let i = lo; i <= hi; i += 1) {
    const row = visible[i];
    if (row !== undefined) ids.add(row.id);
  }
  return ids;
};

/** The in-process detail line for the cursor row (folder unit facts / chat facts). */
export const buildDetailText = (
  state: PickerState,
  row: Row | undefined,
): string => {
  if (row === undefined) return '';
  if (row.kind === 'folder') {
    const counts = selectFolderCounts(state, row);
    return `folder "${row.title}" · ${String(counts.members)} of ${String(counts.total)} in scope · ${String(counts.writable)} writable · r/w = whole folder`;
  }
  const parts: string[] = [`${KIND_GLYPH[row.chatKind]} ${row.title}`, row.chatKind];
  if (row.username !== undefined) parts.push(`@${row.username}`);
  if (row.folderTitles.length > 0) {
    parts.push(`in folders: ${row.folderTitles.join(', ')}`);
  }
  return parts.join(' · ');
};

/** Map one model `Row` -> the `TreeRowProps` the shared component renders. */
const toTreeRowProps = (
  state: PickerState,
  row: Row,
  isCursor: boolean,
  inVisualRange: boolean,
): TreeRowProps => {
  if (row.kind === 'chat') {
    return {
      row,
      isCursor,
      inVisualRange,
      effective: resolveEffective(state, row.chatKey),
    };
  }
  // The pinned "whole folder as a unit" row: its token is the uniform access of its member
  // chats (what `r`/`w` cascaded); a mixed folder shows tri-state only.
  const triState = deriveFolderTriState(state, row);
  const counts = selectFolderCounts(state, row);
  const selectedNote = counts.members > 0 ? ` · ${String(counts.members)} in scope` : '';
  const folderSummary = `Entire "${row.title}" folder · ${String(counts.total)} chats${selectedNote}`;
  const base: TreeRowProps = { row, isCursor, inVisualRange, triState, folderSummary };
  const bits = uniformFolderBits(state, row);
  return bits === undefined ? base : { ...base, folderBits: bits };
};

/**
 * The picker screen's render-time props: the full reducer state + a dispatch sink + the
 * exit seam, plus an optional theme override for deterministic render-tests. The component
 * is a pure projection of `state` through the derived selectors; key events route through
 * the settled `defaultPickerBindings` table to `dispatch`.
 */
export interface PickerScreenComponentProps {
  readonly state: PickerState;
  readonly onExit: (committed: boolean) => void;
  readonly dispatch: (action: PickerAction) => void;
  readonly theme?: Theme;
}

export const PickerScreen: FC<PickerScreenComponentProps> = ({
  state,
  onExit,
  dispatch,
  theme = defaultTheme,
}) => {
  const [helpOpen, setHelpOpen] = useState(false);
  const [termRows, setTermRows] = useState<number>(
    PICKER_LAYOUT.fallbackTerminalRows,
  );
  const { stdout } = useStdout();

  // Feed the real terminal height back into the reducer so the list window fits; re-measure
  // on resize. The list is the only thing that scrolls (chrome is fixed).
  useEffect(() => {
    const apply = (): void => {
      // Ink does not scroll/virtualise the live region, so window the list to the measured
      // terminal height (Ink's documented `useStdout().stdout.rows`). If the height is
      // unknown (non-TTY / test mock), fall back to a small value that fits any screen rather
      // than risk an over-tall frame.
      const term = Number.isFinite(stdout.rows)
        ? stdout.rows
        : PICKER_LAYOUT.fallbackTerminalRows;
      setTermRows(term);
      dispatch({
        type: 'setViewportRows',
        rows: Math.max(PICKER_LAYOUT.minViewportRows, term - PICKER_LAYOUT.chromeRows),
      });
    };
    apply();
    stdout.on('resize', apply);
    return (): void => {
      stdout.off('resize', apply);
    };
  }, [stdout, dispatch]);

  // --- Esc precedence: shed a live filter first, then the `?` overlay, else exit.
  const handleEsc = useCallback((): void => {
    const hasFilter = state.query.trim() !== '' || state.focus === 'search';
    if (hasFilter) {
      dispatch({ type: 'clearFilter' });
      dispatch({ type: 'setFocus', focus: 'tree' });
    } else if (helpOpen) {
      setHelpOpen(false);
    } else {
      onExit(false);
    }
  }, [state.query, state.focus, helpOpen, dispatch, onExit]);

  const onAction = useCallback(
    (action: PickerAction): void => {
      dispatch(action);
    },
    [dispatch],
  );
  const onMeta = useCallback(
    (binding: KeyBinding): void => {
      switch (binding.id) {
        case MetaBindingId.Save:
          onExit(true); // explicit save (`s`) — the only thing that commits
          return;
        case MetaBindingId.Find:
          dispatch({ type: 'setFocus', focus: 'search' });
          return;
        case MetaBindingId.Help:
          setHelpOpen(true);
          return;
        case MetaBindingId.Back:
          handleEsc();
          return;
        default:
          return;
      }
    },
    [dispatch, handleEsc, onExit],
  );
  // No type-to-filter: an unlisted key is a no-op — we don't hijack it into search. Search is
  // entered explicitly with `/` (the Find meta binding), which is predictable and matches the
  // footer hint.
  useKeyBindings({
    state,
    isActive: state.focus === 'tree' && !helpOpen,
    onAction,
    onMeta,
  });

  // --- Search box is a plain text field while focused: r/w can never fire here.
  const onSearchKey = useCallback(
    (input: string, key: Key): void => {
      if (key.escape) {
        handleEsc();
        return;
      }
      if (key.return) {
        dispatch({ type: 'setFocus', focus: 'tree' });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'move', direction: 'up' });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'move', direction: 'down' });
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({ type: 'setFilter', query: state.query.slice(0, -1) });
        return;
      }
      if (key.ctrl || key.meta || key.tab) return;
      if (input.length >= 1) {
        dispatch({ type: 'setFilter', query: state.query + input });
      }
    },
    [dispatch, state.query, handleEsc],
  );
  useInput(onSearchKey, { isActive: state.focus === 'search' && !helpOpen });

  // --- Overlay capture: any key dismisses the `?` help.
  useInput(
    () => {
      setHelpOpen(false);
    },
    { isActive: helpOpen },
  );

  // --- Pure projection of state -> view (derived selectors; never stored). -----
  const tabs = selectTabs(state);
  const visible = selectVisibleRows(state);
  const win = selectWindow(state);
  const { shown, total } = selectShownCounts(state);
  const { inScope, writable } = computeHeaderCounts(state);
  const cursorRow =
    state.cursorRowId === undefined
      ? undefined
      : state.rows.find((r) => r.id === state.cursorRowId);
  const rangeIds = visualRangeIds(visible, state.visualAnchorRowId, state.cursorRowId);
  const detail = buildDetailText(state, cursorRow);

  // Fill the terminal (minus one row of headroom so the frame stays strictly
  // shorter than the screen — the condition Ink needs to redraw in place).
  const frameHeight = Math.max(
    PICKER_LAYOUT.minFrameRows,
    termRows - PICKER_LAYOUT.bottomHeadroomRows,
  );

  // Help takes the whole screen so it never overflows the fixed-height layout.
  if (helpOpen) {
    return (
      <Box flexDirection="column" height={frameHeight}>
        <HelpOverlay bindings={defaultPickerBindings} theme={theme} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={frameHeight}>
      <Box flexDirection="column">
        <Header
          endpointName={state.endpointName}
          inScopeCount={inScope}
          writableCount={writable}
          shown={shown}
          total={total}
          theme={theme}
        />
        <TabBar tabs={tabs} activeKey={state.activeTabKey} theme={theme} />
        <SearchInput
          query={state.query}
          focused={state.focus === 'search'}
          matchCount={shown}
          theme={theme}
        />
        {win.above > 0 ? (
          <Text {...colorProps(theme.color.inherited)}>{`  ↑ ${String(win.above)} more`}</Text>
        ) : null}
        <Box flexDirection="column">
          {win.rows.length === 0 ? (
            <Text {...colorProps(theme.color.inherited)}>{'(no chats match)'}</Text>
          ) : (
            win.rows.map((row) => (
              <TreeRow
                key={row.id}
                {...toTreeRowProps(
                  state,
                  row,
                  row.id === state.cursorRowId,
                  rangeIds.has(row.id),
                )}
                theme={theme}
              />
            ))
          )}
        </Box>
        {win.below > 0 ? (
          <Text {...colorProps(theme.color.inherited)}>{`  ↓ ${String(win.below)} more`}</Text>
        ) : null}
        <DetailLine text={detail} theme={theme} />
      </Box>
      {/* Spacer fills the slack, pinning the footer nav to the bottom of the screen. */}
      <Box flexGrow={1} />
      {/* One blank line between the content above and the bottom nav. */}
      <Box marginTop={1} flexDirection="column">
        <Footer bindings={defaultPickerBindings} state={state} theme={theme} />
      </Box>
    </Box>
  );
};
