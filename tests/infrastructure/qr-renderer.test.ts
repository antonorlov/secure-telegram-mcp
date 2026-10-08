/**
 * Terminal QR renderer — pins the geometry contract that keeps the block scannable:
 * rectangular output, an intact light quiet zone on all four edges (the library's
 * `small` terminal mode used to leave the bottom row half-painted on odd row
 * counts), and stability across token lengths (module counts of both parities).
 */
import { describe, expect, it } from 'vitest';

import { renderTerminalQr } from '../../src/infrastructure/qr/qrcode-qr-renderer.js';

const FULL = '\u2588';

describe('renderTerminalQr', () => {
  it.each([
    'tg://login?token=short',
    'tg://login?token=AQQ-JFlqYmGMtxrGR3JyupNrBkb5bKHebfzARbT6nF7byA',
  ])('renders a rectangular block with intact quiet-zone edges (%s)', (url) => {
    const qr = renderTerminalQr(url);
    expect(qr).toBeDefined();
    const lines = (qr ?? '').split('\n');
    const width = lines[0]?.length ?? 0;
    expect(width).toBeGreaterThan(0);
    // Rectangular: no ragged rows.
    for (const line of lines) expect(line).toHaveLength(width);
    // The quiet zone survives on every edge: first and last rows fully light,
    // every row starting and ending light (a full block covers both halves).
    expect(lines[0]).toBe(FULL.repeat(width));
    expect(lines[lines.length - 1]).toBe(FULL.repeat(width));
    for (const line of lines) {
      expect(line.startsWith(FULL)).toBe(true);
      expect(line.endsWith(FULL)).toBe(true);
    }
  });
});
