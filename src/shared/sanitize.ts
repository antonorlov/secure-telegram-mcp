/**
 * Purely structural cleaning, never keyword or heuristic filtering: NFC-normalise, drop Unicode
 * Cc/Cf control and format code points except \n and \t, then cap per field in CODE POINTS and
 * append a model-visible `[truncated]` marker.
 * Homoglyphs are deliberately left intact — folding them is lossy and brittle, and the defence
 * is structural cleaning plus structured-JSON emission.
 */

/**
 * Strips Cc/Cf — including the U+E0000-E007F tag block used for ASCII smuggling, zero-width,
 * bidi and BOM — plus the variation selectors, an emoji-presentation channel with no legible
 * meaning. General combining diacritics are legitimate and kept.
 */
const STRIPPED_CODE_POINT =
  /\p{Cc}|\p{Cf}|[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;

// Cc code points that are legible whitespace and therefore preserved.
const PRESERVED_CONTROLS: ReadonlySet<string> = new Set(['\n', '\t']);

// Default per-field length cap (code points) before `[truncated]` is appended.
export const DEFAULT_MAX_FIELD_LENGTH = 8192;

// Explicit, model-visible marker appended when a field is length-capped.
export const TRUNCATION_MARKER = '[truncated]';

// Clean a single raw string; pure (same input -> same output). The cap is in CODE POINTS over
// the CLEANED text, and the explicit `[truncated]` marker is appended when it bites.
export const sanitizeString = (
  raw: string,
  maxLength: number = DEFAULT_MAX_FIELD_LENGTH,
): string => {
  const cap = Math.max(0, maxLength);

  const normalized = raw.normalize('NFC');
  const kept: string[] = [];

  for (const ch of normalized) {
    if (PRESERVED_CONTROLS.has(ch)) {
      kept.push(ch);
      continue;
    }
    if (STRIPPED_CODE_POINT.test(ch)) {
      continue;
    }
    kept.push(ch);
  }

  const truncated = kept.length > cap;
  const body = (truncated ? kept.slice(0, cap) : kept).join('');
  return truncated ? `${body}${TRUNCATION_MARKER}` : body;
};
