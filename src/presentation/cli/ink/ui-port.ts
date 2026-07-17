/**
 * UI port — the seam between the framework-free picker/review use-cases and the Ink
 * render/input adapter. The use-cases depend only on these narrow role interfaces; the Ink
 * layer implements them. This keeps the enumerate/save logic free of any Ink/React import
 * and unit-testable with fakes (and the picker reducer pure).
 *
 * Framework-free: no React/Ink import — only plain DTOs + the picker model + the domain verb
 * vocabulary.
 */
import type { AccessBits } from '../picker/index.js';

// Review spoke (security-first: resolved matrix + diff + blast radius)

/** One row of the resolved access matrix shown before save. */
export interface ReviewMatrixRow {
  readonly title: string;
  readonly bits: AccessBits;
}

/** The inverse blast-radius audit entry ("this chat is exposed where"). */
export interface BlastRadiusEntry {
  readonly title: string;
  /** Endpoints (by name) that would gain write to this chat after save. */
  readonly writableFromEndpoints: readonly string[];
}

export interface ReviewInput {
  readonly endpointName: string;
  readonly matrix: readonly ReviewMatrixRow[];
  /** Human-readable scope/access diff vs. the on-disk config. */
  readonly diff: readonly string[];
  readonly blastRadius: readonly BlastRadiusEntry[];
  /** True when any chat would be writable — gates the type-the-name confirm. */
  readonly hasWritable: boolean;
}

/** The review outcome: cancel (default-safe) or a confirmed save. */
export type ReviewDecision =
  | { readonly type: 'cancel' }
  | { readonly type: 'confirm-save' };

// Menu spoke (the reusable arrow-nav select: one model for every choice menu)

/**
 * One selectable menu option: the opaque `value` the caller switches on, the `label`
 * rendered as the row, and an optional dim `hint` shown beside it. Generic over the value so
 * a caller keeps a precise union rather than stringly-typed choices.
 */
export interface MenuOption<T> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
}

/** The DTO one arrow-nav menu renders: a title, an optional subtitle, the options. */
export interface MenuRequest<T> {
  readonly title: string;
  readonly subtitle?: string;
  readonly options: readonly MenuOption<T>[];
}

/**
 * A menu outcome: the chosen option's `value`, or a cancel (Esc/q) — the caller
 * maps cancel onto its own safe default (quit / back / abort). Discriminated so a
 * cancel can never be mistaken for a selection.
 */
export type MenuResult<T> =
  | { readonly kind: 'selected'; readonly value: T }
  | { readonly kind: 'cancelled' };
