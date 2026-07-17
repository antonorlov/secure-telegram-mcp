/**
 * UnicodeSanitizer — the concrete untrusted-content sanitization CHOKEPOINT and
 * the SOLE constructor of `UntrustedText`. A thin infrastructure adapter over the
 * pure cleaning rules in `shared/sanitize`: NFC-normalise, drop Cc/Cf except \n\t
 * (zero-width/joiner/bidi/BOM + controls), per-field length cap with an explicit
 * `[truncated]` marker.
 */
import {
  UntrustedText,
  type UntrustedTextKind,
} from '../../domain/index.js';
import { sanitizeString } from '../../shared/index.js';

export class UnicodeSanitizer {
  public sanitize(kind: UntrustedTextKind, raw: string): UntrustedText {
    return UntrustedText.wrapSanitized(kind, sanitizeString(raw));
  }
}
