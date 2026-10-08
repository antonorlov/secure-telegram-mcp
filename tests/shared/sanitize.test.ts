/**
 * Unit tests for the pure sanitization SSOT (`shared/sanitize`) — the cleaning
 * RULES behind the untrusted-content chokepoint (#6). Covers the adversarial
 * cases the chokepoint exists for: zero-width/joiner, bidi override/isolate,
 * BOM, C0/C1 controls, NFC folding, homoglyphs (deliberately preserved), and
 * the explicit truncation marker.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeString, TRUNCATION_MARKER } from '../../src/shared/index.js';

const ZWSP = String.fromCharCode(0x200b); // zero-width space (Cf)
const ZWNJ = String.fromCharCode(0x200c); // zero-width non-joiner (Cf)
const ZWJ = String.fromCharCode(0x200d); // zero-width joiner (Cf)
const BOM = String.fromCharCode(0xfeff); // BOM / zero-width no-break space (Cf)
const RLO = String.fromCharCode(0x202e); // right-to-left override (Cf)
const LRI = String.fromCharCode(0x2066); // left-to-right isolate (Cf)
const PDI = String.fromCharCode(0x2069); // pop directional isolate (Cf)
const NUL = String.fromCharCode(0x00); // C0 control (Cc)
const BEL = String.fromCharCode(0x07); // C0 control (Cc)
const ESC = String.fromCharCode(0x1b); // C0 control (Cc)
const DEL = String.fromCharCode(0x7f); // C1-range control (Cc)

// 'e' + combining acute accent (U+0301) NFC-folds to precomposed 'é' (U+00E9).
const DECOMPOSED_E_ACUTE = `e${String.fromCharCode(0x0301)}`;
const PRECOMPOSED_E_ACUTE = String.fromCharCode(0x00e9);

// Cyrillic small letter U+0430 — a homoglyph of Latin 'a' (U+0061).
const CYRILLIC_A = String.fromCharCode(0x0430);

describe('sanitizeString', () => {
  it('strips zero-width, joiner, bidi-override/isolate and BOM (all Cf)', () => {
    const raw = `a${ZWSP}b${ZWNJ}${ZWJ}c${RLO}d${LRI}e${PDI}${BOM}f`;
    expect(sanitizeString(raw)).toBe('abcdef');
  });

  it('strips C0/C1 control chars (NUL, BEL, ESC, DEL) but keeps text', () => {
    expect(sanitizeString(`x${NUL}y${BEL}z${ESC}${DEL}w`)).toBe('xyzw');
  });

  it('preserves newline and tab (the only allowed control chars)', () => {
    expect(sanitizeString(`a\nb\tc${NUL}d`)).toBe('a\nb\tcd');
  });

  it('NFC-normalises canonically-equivalent decomposed sequences', () => {
    expect(sanitizeString(DECOMPOSED_E_ACUTE)).toBe(PRECOMPOSED_E_ACUTE);
  });

  it('strips the Unicode tag block U+E0000-E007F (the ASCII-smuggling channel)', () => {
    const TAG_BEGIN = String.fromCodePoint(0xe0001); // language tag
    const TAG_A = String.fromCodePoint(0xe0041); // hidden 'A'
    const TAG_CANCEL = String.fromCodePoint(0xe007f);
    expect(sanitizeString(`x${TAG_BEGIN}${TAG_A}${TAG_CANCEL}y`)).toBe('xy');
  });

  it('strips variation selectors (the emoji-presentation smuggling channel)', () => {
    const VS16 = String.fromCodePoint(0xfe0f); // basic variation selector
    const VS_SUPP = String.fromCodePoint(0xe0101); // supplement range
    expect(sanitizeString(`a${VS16}b${VS_SUPP}c`)).toBe('abc');
  });

  it('KEEPS legitimate combining diacritics (only smuggling marks are stripped)', () => {
    const combiningAcute = String.fromCodePoint(0x0301);
    // é (decomposed) -> NFC precomposed, nothing stripped.
    expect(sanitizeString(`e${combiningAcute}`)).toBe('é');
  });

  it('leaves homoglyphs intact (structural cleaning only — no confusable folding)', () => {
    // The dangerous wrapper (RLO) is stripped; the homoglyph letter survives.
    const out = sanitizeString(`${RLO}${CYRILLIC_A}dmin`);
    expect(out).toBe(`${CYRILLIC_A}dmin`);
    expect(out).not.toBe('admin'); // NOT folded to the Latin look-alike
  });

  it('caps length by code points and appends the explicit truncation marker', () => {
    expect(sanitizeString('abcdef', 3)).toBe(`abc${TRUNCATION_MARKER}`);
  });

  it('does not append a marker when within the cap', () => {
    expect(sanitizeString('abc', 3)).toBe('abc');
  });

  it('measures the cap AFTER stripping (removed chars do not count toward it)', () => {
    // 3 visible chars + zero-width noise; cap of 3 must NOT trip.
    expect(sanitizeString(`a${ZWSP}b${ZWSP}c`, 3)).toBe('abc');
  });
});
