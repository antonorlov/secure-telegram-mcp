/**
 * Output / media SIZE CAPS — byte and item ceilings that bound how much
 * untrusted content can enter the model context. Pure predicates that only
 * MEASURE and COMPARE; mapping an over-cap result to an error is the enforcing
 * layer's job.
 */

/** Max serialized structured-output bytes a single tool result may return. */
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export interface ByteCapResult {
  /** Exact UTF-8 byte length measured. */
  readonly byteLength: number;
  /** The ceiling it was compared against. */
  readonly maxBytes: number;
  /** True iff `byteLength <= maxBytes`. */
  readonly withinCap: boolean;
}

/**
 * Measure a serialized string's UTF-8 byte length and compare to a cap. Uses
 * BYTE length (not `.length`) because the cap protects the model context, which
 * is consumed in bytes/tokens, not UTF-16 code units.
 */
export const checkByteCap = (
  serialized: string,
  maxBytes: number,
): ByteCapResult => {
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  return Object.freeze({ byteLength, maxBytes, withinCap: byteLength <= maxBytes });
};
