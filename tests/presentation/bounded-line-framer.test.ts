import { describe, expect, it } from 'vitest';

import { BoundedLineFramer } from '../../src/presentation/bounded-line-framer.js';

describe('BoundedLineFramer', () => {
  it('preserves split UTF-8 and emits multiple lines in order', () => {
    const framer = new BoundedLineFramer(64);
    const lines: string[] = [];
    const bytes = Buffer.from('Jose 🚀\nsecond\npartial', 'utf8');
    const split = bytes.indexOf(Buffer.from('🚀', 'utf8')) + 1;

    expect(framer.push(bytes.subarray(0, split), (line) => { lines.push(line); }))
      .toBe(true);
    expect(framer.push(bytes.subarray(split), (line) => { lines.push(line); }))
      .toBe(true);
    expect(lines).toEqual(['Jose 🚀', 'second']);
    expect(framer.push(Buffer.from('-tail\n'), (line) => { lines.push(line); }))
      .toBe(true);
    expect(lines).toEqual(['Jose 🚀', 'second', 'partial-tail']);
  });

  it('accepts the exact byte limit and rejects one byte more', () => {
    const lines: string[] = [];
    const exact = new BoundedLineFramer(4);
    expect(exact.push(Buffer.from('éé\n'), (line) => { lines.push(line); }))
      .toBe(true);
    expect(lines).toEqual(['éé']);

    const over = new BoundedLineFramer(4);
    expect(over.push(Buffer.from('ééx\n'), () => undefined)).toBe(false);
    expect(over.push(Buffer.from('ok\n'), (line) => { lines.push(line); }))
      .toBe(true);
    expect(lines.at(-1)).toBe('ok');
  });

  it('stops without delivering the remainder when the consumer refuses', () => {
    const lines: string[] = [];
    const framer = new BoundedLineFramer(32);
    expect(
      framer.push(Buffer.from('first\nsecond\n'), (line) => {
        lines.push(line);
        return false;
      }),
    ).toBe(false);
    expect(lines).toEqual(['first']);
  });
});
