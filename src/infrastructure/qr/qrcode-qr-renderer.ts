/**
 * `qrcode` adapter functions. The setup flow only needs success/failure to choose
 * its URL fallback, so rendering errors stay inside this infrastructure boundary.
 *
 * The terminal block is rendered here from the bit matrix rather than via the
 * library's `small` terminal mode: that mode packs two module-rows per text row and
 * leaves the final row half-painted whenever the row count is odd — the terminal
 * background then bites into the bottom quiet zone (a real scan-reliability loss,
 * not just cosmetics). Rendering ourselves guarantees a symmetric quiet zone and an
 * even row count for any token length.
 */
import * as QRCode from 'qrcode';

/** Quiet-zone width in modules on every side (spec minimum is 4 at print scale;
 * 2 is ample for a self-luminous terminal and keeps the block compact). */
const QUIET_MODULES = 2;

/** Half-block glyph for a (top, bottom) pair of light flags. */
const halfBlock = (top: boolean, bottom: boolean): string =>
  top ? (bottom ? '\u2588' : '\u2580') : bottom ? '\u2584' : ' ';

export const renderTerminalQr = (url: string): string | undefined => {
  try {
    const matrix = QRCode.create(url).modules;
    const dim = matrix.size + QUIET_MODULES * 2;
    // Pad to an even row count (QR sizes are odd) with one extra light row — a
    // hair of surplus quiet zone instead of a half-painted bottom edge.
    const rows = dim % 2 === 0 ? dim : dim + 1;
    const lightAt = (row: number, col: number): boolean => {
      const r = row - QUIET_MODULES;
      const c = col - QUIET_MODULES;
      if (r < 0 || c < 0 || r >= matrix.size || c >= matrix.size) return true;
      return matrix.get(r, c) === 0;
    };
    const lines: string[] = [];
    for (let row = 0; row < rows; row += 2) {
      let line = '';
      for (let col = 0; col < dim; col += 1) {
        line += halfBlock(lightAt(row, col), lightAt(row + 1, col));
      }
      lines.push(line);
    }
    return lines.join('\n');
  } catch {
    return undefined;
  }
};

export const writeQrPng = async (
  url: string,
  path: string,
): Promise<boolean> => {
  try {
    await QRCode.toFile(path, url, { type: 'png' });
    return true;
  } catch {
    return false;
  }
};
