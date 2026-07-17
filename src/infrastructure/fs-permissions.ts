/**
 * fs-permissions — the at-rest permission modes of SECRET-bearing files and
 * directories. Owner-only: `0600` for files, `0700` for directories. Every writer
 * of a secret imports these, so the octal modes live in ONE place and never drift.
 */
export const SECRET_MODES = {
  /** Owner read/write only — for any file that may hold a secret at rest. */
  file: 0o600,
  /** Owner read/write/execute only — for directories that contain such files. */
  dir: 0o700,
} as const;
