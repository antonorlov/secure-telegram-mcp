// Owner-only at-rest modes for secret-bearing files (0600) and directories (0700), defined once
// so they never drift.
export const SECRET_MODES = {
  file: 0o600,
  dir: 0o700,
} as const;
