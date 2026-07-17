import { describe, it, expect } from 'vitest';
import {
  UnicodeSanitizer,
} from '../../src/infrastructure/index.js';
import { UntrustedTextKind } from '../../src/domain/index.js';

const ZWSP = String.fromCharCode(0x200b); // zero-width space (Cf)
const RLO = String.fromCharCode(0x202e); // right-to-left override (Cf)
const BOM = String.fromCharCode(0xfeff); // BOM / zero-width no-break space (Cf)
const NUL = String.fromCharCode(0x00); // C0 control (Cc)
const ESC = String.fromCharCode(0x1b); // C0 control (Cc)

// 'e' + combining acute accent (U+0301) -> should NFC-normalise to U+00E9.
const DECOMPOSED_E_ACUTE = `e${String.fromCharCode(0x0301)}`;
const PRECOMPOSED_E_ACUTE = String.fromCharCode(0x00e9);

describe('UnicodeSanitizer', () => {
  const sanitizer = new UnicodeSanitizer();

  it('strips zero-width and bidi-override format chars but keeps newline and tab', () => {
    const raw = `a${ZWSP}b${RLO}c\nd\te`;
    const out = sanitizer.sanitize(UntrustedTextKind.Body, raw);
    expect(out.sanitizedValue).toBe('abc\nd\te');
  });

  it('strips the BOM / zero-width-no-break-space', () => {
    const out = sanitizer.sanitize(UntrustedTextKind.ChatTitle, `${BOM}hi`);
    expect(out.sanitizedValue).toBe('hi');
  });

  it('strips C0 control chars (NUL, ESC) but not text', () => {
    const out = sanitizer.sanitize(UntrustedTextKind.Body, `x${NUL}y${ESC}z`);
    expect(out.sanitizedValue).toBe('xyz');
  });

  it('NFC-normalises decomposed sequences', () => {
    const out = sanitizer.sanitize(
      UntrustedTextKind.SenderDisplayName,
      DECOMPOSED_E_ACUTE,
    );
    expect(out.sanitizedValue).toBe(PRECOMPOSED_E_ACUTE);
  });

  it('caps length and appends an explicit [truncated] marker (default 8192 code points)', () => {
    const oversized = 'a'.repeat(9000);
    expect(
      sanitizer.sanitize(UntrustedTextKind.Body, oversized).sanitizedValue,
    ).toBe(`${'a'.repeat(8192)}[truncated]`);
    // Within-cap text is returned verbatim (no marker).
    expect(sanitizer.sanitize(UntrustedTextKind.Body, 'abc').sanitizedValue).toBe(
      'abc',
    );
  });

  it('emits as structured JSON under the named key', () => {
    const out = sanitizer.sanitize(UntrustedTextKind.Body, 'hello');
    expect(out.toStructured()).toEqual({ untrusted_text: 'hello' });
  });
});
