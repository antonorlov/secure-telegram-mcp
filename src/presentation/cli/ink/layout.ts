/**
 * layout — the full-screen picker's terminal-layout dimensions, all in terminal rows.
 * Centralised so the window-sizing math (viewport height, bottom-pinned footer, non-overflow
 * headroom) has one place to tune and no bare numbers leak into the render code.
 */
export const PICKER_LAYOUT = {
  /**
   * Rows reserved for the fixed chrome (header, tab strip, search line, scroll hints, detail
   * line, the blank gap, and the footer nav). Kept comfortably above the real chrome height so
   * the frame stays strictly shorter than the terminal — Ink redraws in place only when the
   * frame fits, else it appends.
   */
  chromeRows: 14,
  /** Fallback terminal height when `stdout.rows` is unknown (non-TTY / test mock). */
  fallbackTerminalRows: 24,
  /** Smallest the scrolling list window may shrink to on a very short terminal. */
  minViewportRows: 3,
  /** Smallest total frame height (guards tiny/degenerate terminals). */
  minFrameRows: 8,
  /** Headroom kept below the frame so it never reaches the terminal's last row. */
  bottomHeadroomRows: 1,
  /**
   * Fixed display width (terminal columns) of a chat row's title cell. Longer titles truncate
   * with `…`, shorter ones pad — so the `r`/`rw` access token always lands in the same column
   * down the whole list (Ink measures Unicode / emoji width for the truncation).
   */
  titleColumns: 48,
  /** Blank columns between the title cell and the r/w access token (breathing room). */
  titleGapColumns: 3,
  /** Width of the access-token cell (`r` / `w` / `rw`) so anything after it aligns. */
  accessTokenColumns: 2,
} as const;
