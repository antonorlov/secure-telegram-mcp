import { closeSync, fchmodSync, openSync, writeFileSync } from 'node:fs';

import { SECRET_MODES } from './fs-permissions.js';

/**
 * setup-debug-log — an OPT-IN diagnostic sink for the setup flow. It writes ONLY
 * when `TELEGRAM_MCP_DEBUG_LOG=<path>` is set; otherwise every call is a no-op.
 *
 * Error messages are deliberately omitted: an arbitrary dependency exception may
 * contain operator input. The sink keeps the error class and stack frames, which
 * retain the useful code location without copying possible credentials. The file
 * is forced to 0600 before every append. Never throws.
 */
const target = (): string | undefined => {
  const path = process.env['TELEGRAM_MCP_DEBUG_LOG'];
  return path !== undefined && path.length > 0 ? path : undefined;
};

const cleanDiagnostic = (value: string, maxLength = 4096): string =>
  value.replace(/[^\x20-\x7E\n\t]/g, '').slice(0, maxLength);

const appendDiagnostic = (entry: string): boolean => {
  const path = target();
  if (path === undefined) {
    return false;
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'a', SECRET_MODES.file);
    if (process.platform !== 'win32') {
      fchmodSync(descriptor, SECRET_MODES.file);
    }
    writeFileSync(descriptor, entry, 'utf8');
    return true;
  } catch {
    /* never let logging break setup */
    return false;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* never let logging break setup */
      }
    }
  }
};

/** Append caller-owned, non-secret setup diagnostics. */
export const debugLog = (context: string, detail = ''): boolean =>
  appendDiagnostic(
    `[${new Date().toISOString()}] ${cleanDiagnostic(context, 128)}${
      detail.length > 0 ? ` ${cleanDiagnostic(detail)}` : ''
    }\n`,
  );

/** Append a secret-safe exception fingerprint and stack location. */
export const debugLogError = (context: string, error: unknown): boolean => {
  const name =
    error instanceof Error ? cleanDiagnostic(error.name, 128) : 'UnknownError';
  const frames =
    error instanceof Error
      ? (error.stack ?? '')
          .split(/\r?\n/)
          .filter((line) => /^\s*at\s/.test(line))
          .slice(0, 20)
          .map((line) => cleanDiagnostic(line, 1024))
      : [];
  return appendDiagnostic(
    `[${new Date().toISOString()}] ${cleanDiagnostic(context, 128)}: ${name}\n${
      frames.length > 0 ? frames.join('\n') : '(no stack frames)'
    }\n\n`,
  );
};
