/**
 * Theme — the glyph vocabulary + NO_COLOR-safe colour tokens + the small pure read-out
 * formatters (access triad, tri-state/membership glyphs) the Ink picker components render.
 * Framework-free: no Ink/React import, so the formatting rules are unit-testable.
 *
 * NO_COLOR: when `NO_COLOR` is present and non-empty (the de-facto standard), all colour
 * tokens collapse to `undefined`, which Ink's `<Text color>` renders as the terminal
 * default.
 *
 * Glyphs come in two sets behind one interface: single-width Unicode chrome on
 * UTF-8 locales, plain ASCII everywhere else. Both sets
 * are strictly single-cell — emoji stay banned from aligned rows (see WIDTH_AMBIGUOUS).
 */
import type {
  AccessBits,
  EffectiveAccess,
  PickerChatKind,
  TriState,
} from '../picker/index.js';
import { ENDPOINT_TOKEN_PREFIX } from '../../../infrastructure/endpoint-token.js';

// Glyphs (two single-width sets behind one interface; never emoji in aligned rows)

export interface Glyphs {
  /** The cursor caret in the left gutter. */
  readonly cursor: string;
  /** The blank gutter where the cursor is not. */
  readonly noCursor: string;
  /** Membership / tri-state checkboxes. */
  readonly checkFull: string;
  readonly checkPartial: string;
  readonly checkEmpty: string;
}

/** Plain ASCII — render-faithful on dumb terminals and non-UTF-8 locales. */
const GLYPHS_ASCII: Glyphs = Object.freeze({
  cursor: '>',
  noCursor: ' ',
  checkFull: '[x]',
  checkPartial: '[-]',
  checkEmpty: '[ ]',
});

/**
 * Single-width Unicode chrome. Every character here occupies exactly one terminal
 * cell (U+276F, U+2713, U+2013 — none in the width-ambiguous emoji/pictograph ranges),
 * so column alignment is identical to the ASCII set.
 */
const GLYPHS_UNICODE: Glyphs = Object.freeze({
  cursor: '\u276F', // ❯
  noCursor: ' ',
  checkFull: '[\u2713]', // [✓]
  checkPartial: '[\u2013]', // [–]
  checkEmpty: '[ ]',
});

/** The one-char kind marker prefixing a chat title (`# channel`, `@ user`, …). */
export const KIND_GLYPH: Readonly<Record<PickerChatKind, string>> = Object.freeze({
  channel: '#',
  group: '+',
  user: '@',
  self: '~',
});

// Colour tokens (each is an Ink-compatible colour — a hex string here — or undefined
// under NO_COLOR). Ink/chalk downgrade hex to the nearest 256/16-colour automatically,
// so the brand values below are safe on any terminal that has colour at all.

export type ColorToken = string | undefined;

export interface ThemeColors {
  /** Headers / bold chrome. */
  readonly title: ColorToken;
  /** The cursor row accent. */
  readonly cursor: ColorToken;
  /** Inherited (group-default) access — dimmed. */
  readonly inherited: ColorToken;
  /** Read-only access — the safe tint (green) for an in-scope, non-writable chat. */
  readonly read: ColorToken;
  /** Write access — the escalation colour (amber, the one tint that ever warns). */
  readonly write: ColorToken;
  /** Recoverable failures — distinct from `write`: an error is not an escalation. */
  readonly error: ColorToken;
  /** Folder branch rows. */
  readonly folder: ColorToken;
  /** Search-match emphasis. */
  readonly match: ColorToken;
  /** Excluded / out-of-scope read-out. */
  readonly excluded: ColorToken;
  /** Bordered chrome (overlay frames) — the deep brand blue, never small text. */
  readonly frame: ColorToken;
}

/**
 * The brand palette, terminal-tuned: the README's #2E7BD9 family lightened where small
 * text needs contrast on dark screens (the deep blue itself is reserved for frames).
 * read=green / write=amber mirrors the product's permission tiers.
 */
const COLORS_ON: ThemeColors = Object.freeze({
  title: '#6FA8E8',
  cursor: '#6FA8E8',
  inherited: '#64748B',
  read: '#5CCB8B',
  write: '#E8B23A',
  error: '#E86A6A',
  folder: '#93B9E3',
  match: '#5CCB8B',
  excluded: '#64748B',
  frame: '#2E7BD9',
});

const COLORS_OFF: ThemeColors = Object.freeze({
  title: undefined,
  cursor: undefined,
  inherited: undefined,
  read: undefined,
  write: undefined,
  error: undefined,
  folder: undefined,
  match: undefined,
  excluded: undefined,
  frame: undefined,
});

export interface Theme {
  readonly glyph: Glyphs;
  readonly color: ThemeColors;
}

/** True when `NO_COLOR` is present AND non-empty (the NO_COLOR convention). */
export const noColorRequested = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => {
  const v = env['NO_COLOR'];
  return v !== undefined && v !== '';
};

/**
 * True when the locale advertises UTF-8 and the terminal is not `dumb` — the standard
 * POSIX signal (LC_ALL beats LC_CTYPE beats LANG) for whether Unicode chrome is safe.
 */
export const unicodeGlyphsSupported = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => {
  if (env['TERM'] === 'dumb') return false;
  const locale = env['LC_ALL'] ?? env['LC_CTYPE'] ?? env['LANG'] ?? '';
  return /utf-?8/i.test(locale);
};

/**
 * Build a theme. `colorsEnabled` defaults to the inverse of the NO_COLOR signal and
 * `unicodeGlyphs` to the locale sniff; tests pass both explicitly for determinism.
 */
export const createTheme = (options?: {
  readonly colorsEnabled?: boolean;
  readonly unicodeGlyphs?: boolean;
}): Theme => {
  const colorsEnabled = options?.colorsEnabled ?? !noColorRequested();
  const unicodeGlyphs = options?.unicodeGlyphs ?? unicodeGlyphsSupported();
  return {
    glyph: unicodeGlyphs ? GLYPHS_UNICODE : GLYPHS_ASCII,
    color: colorsEnabled ? COLORS_ON : COLORS_OFF,
  };
};

/** The process-default theme (honours NO_COLOR at import); components fall back to it. */
export const defaultTheme: Theme = createTheme();

/**
 * Spread-helper for Ink's `<Text color>`: omits the prop entirely when the token is
 * `undefined` (NO_COLOR), which `exactOptionalPropertyTypes` requires — passing
 * `color={undefined}` explicitly would be a type error.
 */
export const colorProps = (token: ColorToken): { readonly color?: string } =>
  token === undefined ? {} : { color: token };

/** The same omit-when-undefined spread for Ink `<Box borderColor>`. */
export const borderColorProps = (
  token: ColorToken,
): { readonly borderColor?: string } =>
  token === undefined ? {} : { borderColor: token };

// Pure read-out formatters

/**
 * The minimal access read-out for a chat/folder row: `rw` (read+write), `r` (read-only),
 * or empty for a non-member. No provenance tag — the colour (green=read, amber=write) carries
 * the emphasis and the checkbox carries membership, so the token stays quiet in a big list.
 */
export const formatAccessToken = (effective: EffectiveAccess): string => {
  if (!effective.member) return '';
  // Honest, independent bits (chmod model): 'r', 'w', or 'rw' — never claim read when only
  // write is set (write-only is reachable via the `w` pick-up key).
  return `${effective.bits.read ? 'r' : ''}${effective.bits.write ? 'w' : ''}`;
};

/**
 * Emoji / flag / pictograph / variation-selector / ZWJ runs whose rendered width disagrees
 * between `string-width` (what Ink measures with) and real terminals. One regex so the
 * column math has a single definition of "unsafe".
 */
const WIDTH_AMBIGUOUS = // eslint-disable-next-line no-misleading-character-class
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]+/gu;

/**
 * Normalise a title for column alignment: replace width-ambiguous emoji/flag runs with a
 * single space so a title's measured width matches what the terminal draws — the
 * precondition for the `r`/`w`/`rw` tokens to line up down the list. (Only the on-screen
 * title is normalised; the config/session data keep the original text.)
 */
export const toAlignableTitle = (title: string): string =>
  title.replace(WIDTH_AMBIGUOUS, ' ');

/** The same minimal token for a bare `AccessBits` (e.g. the group default). */
export const formatBitsToken = (bits: AccessBits): string => {
  if (!bits.read && !bits.write) return '—';
  if (bits.read && bits.write) return 'rw';
  return bits.read ? 'r' : 'w';
};

/**
 * The access tint for a member row: amber = writable (the escalation warning), green =
 * read-only (safe). A non-member is dim. Colour reinforces the `r`/`rw` text (colourblind
 * users still read the token), never the sole signal — collapses to `undefined`
 * under NO_COLOR.
 */
export const accessColor = (
  effective: EffectiveAccess | undefined,
  theme: Theme,
): ColorToken => {
  if (effective?.member !== true) return theme.color.excluded;
  return effective.bits.write ? theme.color.write : theme.color.read;
};

/** The tint for a bare `AccessBits` (group-default / folder-unit read-out). */
export const bitsColor = (bits: AccessBits, theme: Theme): ColorToken =>
  bits.write ? theme.color.write : bits.read ? theme.color.read : theme.color.excluded;

/** The membership/tri-state checkbox for a folder. */
export const triStateGlyph = (tri: TriState, glyph: Glyphs): string => {
  switch (tri) {
    case 'full':
      return glyph.checkFull;
    case 'partial':
      return glyph.checkPartial;
    case 'none':
      return glyph.checkEmpty;
  }
};

/** The membership checkbox for a chat leaf. */
export const memberGlyph = (member: boolean, glyph: Glyphs): string =>
  member ? glyph.checkFull : glyph.checkEmpty;

// Notice-body line classification (pure — NoticeScreen renders the verdicts)

/**
 * How one notice body line should be tinted. `command`/`comment` are exact substrings
 * of the original line (concatenating them reproduces it byte-for-byte), so colouring
 * never alters what the operator copies.
 */
export type NoticeLineStyle =
  | { readonly kind: 'text' }
  | { readonly kind: 'aside' }
  | { readonly kind: 'payload' }
  | { readonly kind: 'command'; readonly command: string; readonly comment?: string }
  | {
      readonly kind: 'link';
      readonly before: string;
      readonly url: string;
      readonly after: string;
    };

const ASIDE_LINE_RE = /^\s*\(.+\)[.,]?\s*$/;
// A notice's deliverable — the one line the operator came for: a shown-once endpoint
// key (product prefix, SSOT with the minting code) or a written file path.
const PAYLOAD_SECRET_RE = new RegExp(`^\\s*${ENDPOINT_TOKEN_PREFIX}`);
const PAYLOAD_PATH_RE = /^ {2,}[~/]/;
// Indentation alone is not enough — notice bodies also indent bullets, continuation
// lines, and file paths. A command line must open with a runner this product actually
// tells the operator to invoke.
const COMMAND_LINE_RE = /^ {2,}(?:npx|node|npm|docker|git)\b/;
const COMMAND_COMMENT_RE = /^(.*?\s)(#.*)$/;
const URL_RE = /https?:\/\/\S+/;
// Punctuation that belongs to the sentence, not the URL, when it trails the match.
const URL_TRAILING_PUNCT_RE = /[).,;:]+$/;

/**
 * Classify a notice body line for tinting: a payload (a shown-once endpoint key or a
 * written file path — the notice's deliverable) is rendered bold; an indented runner
 * invocation is a command (accent, with a trailing `# comment` dimmed); a line wrapped
 * entirely in parentheses is an aside (dimmed); a prose line containing a URL splits
 * around its first URL (accent + underline — the actionable element); everything else —
 * including indented bullets and continuations — is full-contrast prose. Every split
 * yields exact substrings of the original line, keeping all blocks copy-faithful.
 */
export const classifyNoticeLine = (line: string): NoticeLineStyle => {
  if (PAYLOAD_SECRET_RE.test(line) || PAYLOAD_PATH_RE.test(line)) {
    return { kind: 'payload' };
  }
  if (ASIDE_LINE_RE.test(line)) return { kind: 'aside' };
  if (COMMAND_LINE_RE.test(line)) {
    const split = COMMAND_COMMENT_RE.exec(line);
    if (split?.[1] !== undefined && split[2] !== undefined) {
      return { kind: 'command', command: split[1], comment: split[2] };
    }
    return { kind: 'command', command: line };
  }
  const urlMatch = URL_RE.exec(line);
  if (urlMatch !== null) {
    const raw = urlMatch[0];
    const url = raw.replace(URL_TRAILING_PUNCT_RE, '');
    const start = urlMatch.index;
    return {
      kind: 'link',
      before: line.slice(0, start),
      url,
      after: line.slice(start + url.length),
    };
  }
  return { kind: 'text' };
};
