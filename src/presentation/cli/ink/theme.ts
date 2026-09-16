// Glyph vocabulary, NO_COLOR-safe colour tokens and the pure read-out formatters the Ink picker
// renders. Framework-free, so the formatting rules stay unit-testable.
import type {
  AccessBits,
  EffectiveAccess,
  PickerChatKind,
  TriState,
} from '../picker/index.js';
import { ENDPOINT_TOKEN_PREFIX } from '../../../infrastructure/endpoint-token.js';

export interface Glyphs {
  readonly cursor: string;
  readonly noCursor: string;
  readonly checkFull: string;
  readonly checkPartial: string;
  readonly checkEmpty: string;
}

// Plain ASCII — render-faithful on dumb terminals and non-UTF-8 locales.
const GLYPHS_ASCII: Glyphs = Object.freeze({
  cursor: '>',
  noCursor: ' ',
  checkFull: '[x]',
  checkPartial: '[-]',
  checkEmpty: '[ ]',
});

// Every character here occupies exactly one terminal cell — none from the width-ambiguous emoji
// or pictograph ranges — so column alignment matches the ASCII set.
const GLYPHS_UNICODE: Glyphs = Object.freeze({
  cursor: '\u276F', // ❯
  noCursor: ' ',
  checkFull: '[\u2713]', // [✓]
  checkPartial: '[\u2013]', // [–]
  checkEmpty: '[ ]',
});

// The one-char kind marker prefixing a chat title (`# channel`, `@ user`, …).
export const KIND_GLYPH: Readonly<Record<PickerChatKind, string>> = Object.freeze({
  channel: '#',
  group: '+',
  user: '@',
  self: '~',
});

// Ink and chalk downgrade hex to the nearest 256- or 16-colour automatically, so the brand
// values are safe on any terminal that has colour at all.
export type ColorToken = string | undefined;

export interface ThemeColors {
  readonly title: ColorToken;
  readonly cursor: ColorToken;
  readonly inherited: ColorToken;
  readonly read: ColorToken;
  // Write access — the escalation colour, the one tint that ever warns.
  readonly write: ColorToken;
  // Recoverable failures, deliberately distinct from `write`: an error is not an escalation.
  readonly error: ColorToken;
  readonly folder: ColorToken;
  readonly match: ColorToken;
  readonly excluded: ColorToken;
  readonly frame: ColorToken;
}

// Terminal-tuned brand palette: read=green and write=amber mirror the product's permission
// tiers, and the deep blue stays reserved for frames.
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

// True when `NO_COLOR` is present AND non-empty (the NO_COLOR convention).
export const noColorRequested = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => {
  const v = env['NO_COLOR'];
  return v !== undefined && v !== '';
};

// The standard POSIX signal — LC_ALL beats LC_CTYPE beats LANG — for whether Unicode chrome is
// safe.
export const unicodeGlyphsSupported = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => {
  if (env['TERM'] === 'dumb') return false;
  const locale = env['LC_ALL'] ?? env['LC_CTYPE'] ?? env['LANG'] ?? '';
  return /utf-?8/i.test(locale);
};

// Defaults come from the NO_COLOR signal and the locale sniff; tests pass both explicitly for
// determinism.
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

export const defaultTheme: Theme = createTheme();

// Omits the prop entirely when the token is `undefined`, which `exactOptionalPropertyTypes`
// requires — passing `color={undefined}` would be a type error.
export const colorProps = (token: ColorToken): { readonly color?: string } =>
  token === undefined ? {} : { color: token };

export const borderColorProps = (
  token: ColorToken,
): { readonly borderColor?: string } =>
  token === undefined ? {} : { borderColor: token };

// `rw`, `r`, or empty for a non-member. No provenance tag: the colour carries the emphasis and
// the checkbox carries membership.
export const formatAccessToken = (effective: EffectiveAccess): string => {
  if (!effective.member) return '';
  // Honest, independent bits (chmod model): 'r', 'w', or 'rw' — never claim read when only
  // write is set (write-only is reachable via the `w` pick-up key).
  return `${effective.bits.read ? 'r' : ''}${effective.bits.write ? 'w' : ''}`;
};

// One regex so the column math has a single definition of "unsafe": runs whose rendered width
// disagrees between `string-width`, which Ink measures with, and real terminals.
const WIDTH_AMBIGUOUS = // eslint-disable-next-line no-misleading-character-class
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]+/gu;

// Replace width-ambiguous runs with a single space so a title's measured width matches what the
// terminal draws — the precondition for the access tokens to line up down the list.
export const toAlignableTitle = (title: string): string =>
  title.replace(WIDTH_AMBIGUOUS, ' ');

export const formatBitsToken = (bits: AccessBits): string => {
  if (!bits.read && !bits.write) return '—';
  if (bits.read && bits.write) return 'rw';
  return bits.read ? 'r' : 'w';
};

// Amber marks writable (the escalation warning), green read-only, dim a non-member. Colour
// reinforces the `r`/`rw` text and is never the sole signal.
export const accessColor = (
  effective: EffectiveAccess | undefined,
  theme: Theme,
): ColorToken => {
  if (effective?.member !== true) return theme.color.excluded;
  return effective.bits.write ? theme.color.write : theme.color.read;
};

export const bitsColor = (bits: AccessBits, theme: Theme): ColorToken =>
  bits.write ? theme.color.write : bits.read ? theme.color.read : theme.color.excluded;

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

export const memberGlyph = (member: boolean, glyph: Glyphs): string =>
  member ? glyph.checkFull : glyph.checkEmpty;

// `command` and `comment` are exact substrings of the original line, so colouring never alters
// what the operator copies.
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
/**
 * Indentation alone is not enough — notice bodies also indent bullets, continuation lines, and
 * file paths. A command line must open with a runner this product actually tells the operator
 * to invoke.
 */
const COMMAND_LINE_RE = /^ {2,}(?:npx|node|npm|docker|git)\b/;
const COMMAND_COMMENT_RE = /^(.*?\s)(#.*)$/;
const URL_RE = /https?:\/\/\S+/;
// Punctuation that belongs to the sentence, not the URL, when it trails the match.
const URL_TRAILING_PUNCT_RE = /[).,;:]+$/;

// A payload — a shown-once endpoint key or a written file path — renders bold; an indented
// runner invocation is a command, with a trailing `# comment` dimmed.
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
