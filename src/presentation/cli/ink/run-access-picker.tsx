/**
 * The controlled Ink sub-tree for the wizard's hard step: it renders the pruned-tree
 * PickerScreen and, on commit, the security-first ReviewScreen — the typed-name gate before a
 * writable save.
 */
import { useReducer, useState, type FC } from 'react';

import { PickerScreen } from './screens/PickerScreen.js';
import {
  ReviewScreen,
  type ReviewScreenViewProps,
} from './screens/ReviewScreen.js';
import type {
  BlastRadiusEntry,
  ReviewDecision,
  ReviewInput,
  ReviewMatrixRow,
} from './ui-port.js';
import {
  isCommittedFolderUnit,
  pickerReducer,
  resolveEffective,
  uniqueChatKeys,
  type ChatRow,
  type PickerAction,
  type PickerSelectionModel,
  type PickerState,
  type Row,
} from '../picker/index.js';

export interface AccessPickerRequest {
  readonly initialState: PickerState;
}

export interface AccessPickerResult {
  readonly committed: boolean;
  readonly model: PickerSelectionModel;
}

const chatRowsOf = (rows: readonly Row[]): readonly ChatRow[] =>
  rows.filter((r): r is ChatRow => r.kind === 'chat');

const titleByKey = (rows: readonly Row[]): ReadonlyMap<string, string> => {
  const map = new Map<string, string>();
  for (const row of chatRowsOf(rows)) {
    if (!map.has(row.chatKey)) map.set(row.chatKey, row.title);
  }
  return map;
};

// Decided by the SAME `isCommittedFolderUnit` predicate the projection uses, so the review
// never describes a folder unit that the commit would demote to individual chats.
const committedFolderUnits = (
  rows: readonly Row[],
  model: PickerSelectionModel,
): ReadonlyMap<string, string> => {
  const units = new Map<string, string>();
  for (const row of rows) {
    if (
      row.kind === 'folder' &&
      row.folderKey !== undefined &&
      !units.has(row.folderKey) &&
      isCommittedFolderUnit(
        model,
        row.folderKey,
        row.explicitChatKeys ?? row.childChatKeys,
        row.childChatKeys,
      )
    ) {
      units.set(row.folderKey, row.title);
    }
  }
  return units;
};

/**
 * Pure: the resolved access matrix comes from the reducer's `resolveEffective` selector, and
 * the diff is computed against the `before` model — per-chat membership and committed folder
 * units alike.
 */
export const buildReviewInput = (
  state: PickerState,
  before: PickerSelectionModel,
): ReviewInput => {
  const titles = titleByKey(state.rows);
  const matrix: ReviewMatrixRow[] = [];
  const blastRadius: BlastRadiusEntry[] = [];
  const diff: string[] = [];

  for (const key of uniqueChatKeys(state.rows)) {
    const title = titles.get(key) ?? key;
    const eff = resolveEffective(state, key);
    const wasMember = before.selection.has(key);

    if (eff.member) {
      matrix.push({ title, bits: eff.bits });
      if (eff.bits.write) {
        blastRadius.push({ title, writableFromEndpoints: [state.endpointName] });
      }
      if (!wasMember) diff.push(`+ ${title} (added to scope)`);
    } else if (wasMember) {
      diff.push(`- ${title} (removed from scope)`);
    }
  }

  const unitsBefore = committedFolderUnits(state.rows, before);
  const unitsAfter = committedFolderUnits(state.rows, committedModel(state));
  for (const [key, title] of unitsAfter) {
    if (!unitsBefore.has(key)) {
      diff.push(
        `+ folder "${title}" (tracks explicit members; rule matches are snapshots)`,
      );
    }
  }
  for (const [key, title] of unitsBefore) {
    if (!unitsAfter.has(key)) {
      diff.push(`- folder "${title}" (no longer scoped as a unit)`);
    }
  }

  return {
    endpointName: state.endpointName,
    matrix,
    diff,
    blastRadius,
    hasWritable: blastRadius.length > 0,
  };
};

type HostPhase = 'picker' | 'review';

export interface HostProps {
  readonly initialState: PickerState;
  readonly onDone: (result: AccessPickerResult) => void;
}

const committedModel = (state: PickerState): PickerSelectionModel => ({
  selection: state.selection,
  folderScope: state.folderScope,
});

const hasWritableSelection = (state: PickerState): boolean => {
  for (const key of uniqueChatKeys(state.rows)) {
    const eff = resolveEffective(state, key);
    if (eff.member && eff.bits.write) return true;
  }
  return false;
};

// Folder-unit changes alter a live-tracked scope and always require review.
const hasFolderUnitChange = (
  state: PickerState,
  before: PickerSelectionModel,
): boolean => {
  const beforeUnits = committedFolderUnits(state.rows, before);
  const afterUnits = committedFolderUnits(state.rows, committedModel(state));
  if (beforeUnits.size !== afterUnits.size) return true;
  for (const key of beforeUnits.keys()) {
    if (!afterUnits.has(key)) return true;
  }
  return false;
};

// Exported so the single persistent Ink app mounts this same host as one of its router screens:
// one implementation of picker -> review, whichever path drives it.
export const AccessPickerHost: FC<HostProps> = ({ initialState, onDone }) => {
  const [state, dispatch] = useReducer(pickerReducer, initialState);
  const [phase, setPhase] = useState<HostPhase>('picker');
  // The review baseline IS the selection the edit started from — captured once
  // at mount, so no caller ever supplies (or diverges from) it.
  const [before] = useState<PickerSelectionModel>(() => committedModel(initialState));

  if (phase === 'picker') {
    return (
      <PickerScreen
        state={state}
        dispatch={(action: PickerAction): void => {
          dispatch(action);
        }}
        /**
         * Explicit keys: `s` saves (committed=true), Esc/`q` cancel (committed=false, discard).
         * Writable access and live-tracked folder changes are handed to the security-first
         * review gate first.
         */
        onExit={(committed: boolean): void => {
          if (!committed) {
            onDone({ committed: false, model: committedModel(state) });
          } else if (
            hasWritableSelection(state) ||
            hasFolderUnitChange(state, before)
          ) {
            setPhase('review');
          } else {
            onDone({ committed: true, model: committedModel(state) });
          }
        }}
      />
    );
  }

  const reviewProps: ReviewScreenViewProps = {
    input: buildReviewInput(state, before),
    onDecide: (decision: ReviewDecision): void => {
      onDone({
        committed: decision.type === 'confirm-save',
        model: committedModel(state),
      });
    },
  };
  return <ReviewScreen {...reviewProps} />;
};
