// The full-screen picker's terminal-layout dimensions, in rows and columns. Centralised so the
// window-sizing math has one place to tune and no bare numbers leak into the render code.
export const PICKER_LAYOUT = {
  // Rows reserved for the fixed chrome. Kept comfortably above the real chrome height, so the
  // frame stays strictly shorter than the terminal and Ink redraws in place.
  chromeRows: 14,
  // Fallback terminal height when `stdout.rows` is unknown (non-TTY / test mock).
  fallbackTerminalRows: 24,
  // Smallest the scrolling list window may shrink to on a very short terminal.
  minViewportRows: 3,
  minFrameRows: 8,
  bottomHeadroomRows: 1,
  // Longer titles truncate with `…` and shorter ones pad, so the `r`/`rw` access token always
  // lands in the same column down the whole list.
  titleColumns: 48,
  titleGapColumns: 3,
  // Width of the access-token cell (`r` / `w` / `rw`) so anything after it aligns.
  accessTokenColumns: 2,
} as const;
