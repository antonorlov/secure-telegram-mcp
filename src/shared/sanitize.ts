/**
 * Pure structural sanitization for untrusted Telegram content. Dependency-free
 * so the rules can be unit-tested in isolation and reused by the `Sanitizer`
 * adapter.
 *
 * The cleaning is PURELY STRUCTURAL — never keyword/heuristic filtering:
 *   1. NFC-normalise,
 *   2. drop Unicode Cc/Cf control & format code points EXCEPT \n and \t
 *      (zero-width spaces/joiners, bidi overrides/isolates, BOM/ZWNBSP, C0/C1),
 *   3. apply a per-field length cap (in CODE POINTS) and append an EXPLICIT,
 *      model-visible `[truncated]` marker when it bites.
 *
 * Homoglyphs (e.g. Cyrillic U+0430 vs Latin 'a') are DELIBERATELY left intact:
 * folding them is lossy and brittle; the defence is structural cleaning plus
 * structured-JSON emission under named keys, not confusable matching.
 */

/**
 * Stripped code points: Unicode control (Cc) + format (Cf, incl. the tag block
 * U+E0000-E007F ASCII-smuggling channel + zero-width/bidi/BOM), AND the
 * VARIATION SELECTORS (U+FE00-FE0F, U+E0100-E01EF, category Mn) — an
 * emoji-presentation channel with no legible meaning that is a known hidden-data
 * vector. General combining diacritics (U+0300-036F) are legitimate and KEPT.
 */
const STRIPPED_CODE_POINT =
  /\p{Cc}|\p{Cf}|[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;

/** Cc code points that are legible whitespace and therefore preserved. */
const PRESERVED_CONTROLS: ReadonlySet<string> = new Set(['\n', '\t']);

/** Default per-field length cap (code points) before `[truncated]` is appended. */
export const DEFAULT_MAX_FIELD_LENGTH = 8192;

/** Explicit, model-visible marker appended when a field is length-capped. */
export const TRUNCATION_MARKER = '[truncated]';

/**
 * Clean a single raw string; pure (same input -> same output). The cap is in
 * CODE POINTS over the CLEANED text, and the explicit `[truncated]` marker is
 * appended when it bites.
 */
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
