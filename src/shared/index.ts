/** Public surface of the shared kernel. Pure utilities, no layer dependencies. */
export type { Result } from './result.js';
export { ok, err, isOk, isErr } from './result.js';
export type { Brand } from './branded.js';
export { brand } from './branded.js';
export { assertNever, uniqueFrozen } from './guards.js';

export {
  sanitizeString,
  DEFAULT_MAX_FIELD_LENGTH,
  TRUNCATION_MARKER,
} from './sanitize.js';

export { checkByteCap, DEFAULT_MAX_OUTPUT_BYTES } from './size-caps.js';
