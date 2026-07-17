/**
 * buildReviewInput — the PURE security-first review projection used by the lazy
 * Ink picker mount: the resolved access matrix, the write blast radius, and the
 * before/after scope diff (drives the typed-name gate when anything is writable).
 */
import { describe, it, expect } from 'vitest';

import { buildReviewInput } from '../../../src/presentation/cli/ink/run-access-picker.js';
import { buildPickerTree } from '../../../src/presentation/cli/picker-bridge.js';
import {
  createPickerState,
  type AccessBits,
  type PickerSelectionModel,
} from '../../../src/presentation/cli/picker/index.js';

const { rows } = buildPickerTree([{ id: '9', title: 'Ops', kind: 'group' }]);

const withSelection = (
  entries: readonly [string, AccessBits][],
): PickerSelectionModel => ({ selection: new Map(entries) });

describe('buildReviewInput', () => {
  it('projects a writable grant into the matrix + blast radius and a +diff', () => {
    const before = withSelection([]);
    const after = createPickerState({
      endpointName: 'ops',
      rows,
      selection: new Map<string, AccessBits>([['9', { read: true, write: true }]]),
    });

    const review = buildReviewInput(after, before);

    expect(review.endpointName).toBe('ops');
    expect(review.hasWritable).toBe(true);
    expect(review.matrix).toEqual([
      { title: 'Ops', bits: { read: true, write: true } },
    ]);
    expect(review.blastRadius).toEqual([
      { title: 'Ops', writableFromEndpoints: ['ops'] },
    ]);
    expect(review.diff).toContain('+ Ops (added to scope)');
  });

  it('a read-only scope has nothing writable (no type-the-name gate)', () => {
    const before = withSelection([]);
    const after = createPickerState({
      endpointName: 'ro',
      rows,
      selection: new Map<string, AccessBits>([['9', { read: true, write: false }]]),
    });
    const review = buildReviewInput(after, before);
    expect(review.hasWritable).toBe(false);
    expect(review.blastRadius).toEqual([]);
    expect(review.matrix[0]).toMatchObject({ bits: { read: true, write: false } });
  });

  it('a removed chat shows in the diff as removed', () => {
    const before = withSelection([['9', { read: true, write: false }]]);
    const after = createPickerState({ endpointName: 'ops', rows });
    const review = buildReviewInput(after, before);
    expect(review.diff).toContain('- Ops (removed from scope)');
    expect(review.matrix).toEqual([]);
  });

  it('a folder newly scoped as a UNIT describes tracked and snapshotted members', () => {
    // folders[] refs track explicit members; rule-matched members are fixed chat
    // snapshots. Their add/remove must still be reviewable like chat membership.
    const tree = buildPickerTree(
      [{ id: '9', title: 'Ops', kind: 'group' }],
      [{ id: 5, title: 'Work', chatIds: ['9'] }],
    );
    const before: PickerSelectionModel = { selection: new Map() };
    const after = createPickerState({
      endpointName: 'ops',
      rows: tree.rows,
      selection: new Map<string, AccessBits>([['9', { read: true, write: false }]]),
      folderScope: new Set(['5']),
    });
    const review = buildReviewInput(after, before);
    expect(review.diff).toContain(
      '+ folder "Work" (tracks explicit members; rule matches are snapshots)',
    );
  });

  it('a marked folder with an UNSELECTED child is NOT reviewed as a unit (commit demotes it)', () => {
    // The projection drops a folderScope mark when any current child is
    // unselected (individual chats commit instead). The review must use the
    // SAME predicate — describing "whole folder scoped" here would approve a
    // scope the commit does not produce.
    const tree = buildPickerTree(
      [
        { id: '9', title: 'Ops', kind: 'group' },
        { id: '10', title: 'Eng', kind: 'group' },
      ],
      [{ id: 5, title: 'Work', chatIds: ['9', '10'] }],
    );
    const before: PickerSelectionModel = { selection: new Map() };
    const after = createPickerState({
      endpointName: 'ops',
      rows: tree.rows,
      // '10' was unmarked after the folder was picked — the mark is stale.
      selection: new Map<string, AccessBits>([['9', { read: true, write: false }]]),
      folderScope: new Set(['5']),
    });
    const review = buildReviewInput(after, before);
    expect(review.diff.some((line) => line.includes('folder "Work"'))).toBe(false);
    expect(review.diff).toContain('+ Ops (added to scope)');
  });

  it('a folder DEMOTED by unselecting a child shows as a removed unit in the diff', () => {
    // Same edit seen from a re-entry: the folder committed as a unit BEFORE;
    // this session unselected one child, so the commit will now emit chats
    // instead — the review says the unit went away even though the raw mark
    // is still set (the reducer keeps it; projection demotes).
    const tree = buildPickerTree(
      [
        { id: '9', title: 'Ops', kind: 'group' },
        { id: '10', title: 'Eng', kind: 'group' },
      ],
      [{ id: 5, title: 'Work', chatIds: ['9', '10'] }],
    );
    const before: PickerSelectionModel = {
      selection: new Map<string, AccessBits>([
        ['9', { read: true, write: false }],
        ['10', { read: true, write: false }],
      ]),
      folderScope: new Set(['5']),
    };
    const after = createPickerState({
      endpointName: 'ops',
      rows: tree.rows,
      selection: new Map<string, AccessBits>([['9', { read: true, write: false }]]),
      folderScope: new Set(['5']), // stale mark survives in the reducer state
    });
    const review = buildReviewInput(after, before);
    expect(review.diff).toContain('- folder "Work" (no longer scoped as a unit)');
  });

  it('unmarking a hydrated EMPTY folder scope unit shows in the diff as removed', () => {
    const tree = buildPickerTree(
      [{ id: '9', title: 'Ops', kind: 'group' }],
      [{ id: 7, title: 'Ghost', chatIds: [] }],
    );
    const before: PickerSelectionModel = {
      selection: new Map(),
      folderScope: new Set(['7']),
    };
    const after = createPickerState({ endpointName: 'ops', rows: tree.rows });
    const review = buildReviewInput(after, before);
    expect(review.diff).toContain('- folder "Ghost" (no longer scoped as a unit)');
  });
});
