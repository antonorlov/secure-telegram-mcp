/**
 * useKeyBindings — the input adapter: it bridges Ink's `useInput` to the framework-free binding
 * table (the settled `defaultPickerBindings` keymap). Every keypress is normalised to a
 * `KeyChord` and resolved against the table; a bound action fires `onAction`, a meta binding
 * (find / help / back / quit — no action) fires `onMeta`, and anything unbound is a no-op.
 *
 * All the matching logic lives in `bindings.ts` (pure, tested); this hook is the thin Ink seam
 * so the picker screen stays declarative and the keymap is never re-implemented per screen.
 */
import { useInput } from 'ink';

import { matchBinding, normalizeKeyEvent } from './bindings.js';
import type { KeyBinding } from './components/index.js';
import type { PickerAction, PickerState } from '../picker/index.js';

export interface UseKeyBindingsOptions {
  readonly state: PickerState;
  /** Disable capture (e.g. when an overlay owns input). */
  readonly isActive: boolean;
  /** A bound action fired (dispatch it into the reducer). */
  readonly onAction: (action: PickerAction) => void;
  /** A meta binding fired (find / help / back / quit — the shell decides). */
  readonly onMeta: (binding: KeyBinding) => void;
}

export const useKeyBindings = ({
  state,
  isActive,
  onAction,
  onMeta,
}: UseKeyBindingsOptions): void => {
  useInput(
    (input, key) => {
      const chord = normalizeKeyEvent(input, key);
      if (chord === undefined) return;
      const binding = matchBinding(state, chord);
      if (binding === undefined) return;
      if (binding.action !== undefined) onAction(binding.action);
      else onMeta(binding);
    },
    { isActive },
  );
};
