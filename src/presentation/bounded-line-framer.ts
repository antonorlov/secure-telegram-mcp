/** Incremental newline framing with one hard byte cap and no repeated concatenation. */
export class BoundedLineFramer {
  private buffered: Buffer | undefined;
  private length = 0;

  public constructor(private readonly maxLineBytes: number) {
    if (!Number.isInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new RangeError('maxLineBytes must be a positive integer');
    }
  }

  /**
   * Deliver every complete UTF-8 line in `chunk`. Returns false after overflow or
   * when the consumer asks framing to stop. Split lines are copied once into a
   * reusable bounded buffer; completed single-chunk lines take the zero-copy path.
   */
  public push(
    chunk: Buffer,
    consume: (line: string) => unknown,
  ): boolean {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segmentLength = end - offset;
      if (this.length + segmentLength > this.maxLineBytes) {
        this.clear();
        return false;
      }

      let line: string | undefined;
      if (newline !== -1 && this.length === 0) {
        line = chunk.toString('utf8', offset, end);
      } else if (segmentLength > 0) {
        this.ensureCapacity(this.length + segmentLength);
        const target = this.buffered;
        if (target === undefined) {
          throw new Error('line framer failed to allocate its bounded buffer');
        }
        chunk.copy(target, this.length, offset, end);
        this.length += segmentLength;
      }

      if (newline === -1) return true;
      if (line === undefined) {
        line = this.buffered?.toString('utf8', 0, this.length) ?? '';
        this.wipeBuffered();
      }
      offset = newline + 1;
      if (consume(line) === false) return false;
    }
    return true;
  }

  /** Forget a partial frame and wipe any secret-bearing bytes retained for it. */
  public clear(): void {
    this.wipeBuffered();
  }

  private wipeBuffered(): void {
    this.buffered?.fill(0, 0, this.length);
    this.length = 0;
    if ((this.buffered?.length ?? 0) > 64 * 1024) {
      this.buffered = undefined;
    }
  }

  /** Geometric growth keeps total copying linear without reserving the full cap. */
  private ensureCapacity(required: number): void {
    if ((this.buffered?.length ?? 0) >= required) return;
    let capacity = this.buffered?.length ?? Math.min(1024, this.maxLineBytes);
    while (capacity < required) {
      capacity = Math.min(this.maxLineBytes, capacity * 2);
    }
    const grown = Buffer.allocUnsafe(capacity);
    this.buffered?.copy(grown, 0, 0, this.length);
    this.buffered?.fill(0, 0, this.length);
    this.buffered = grown;
  }
}
