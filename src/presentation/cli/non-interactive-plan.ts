/**
 * Non-interactive plan — the contract for the non-TTY / `--no-input` / CI branch of `setup`.
 * The isatty check happens once at entry: a TTY launches the Ink wizard; a non-TTY must not
 * block on stdin — instead it prints the current config (endpoints + their scope) and exits
 * non-zero, so automation gets a deterministic, secret-safe summary.
 *
 * Framework-free + secret-safe: no Ink import; the formatter masks any session string/token
 * and never echoes secrets. Pure (string in, string out) so it is trivially unit-testable.
 */
import type {
  ValidatedConfig,
  ValidatedEndpoint,
} from '../../config/index.js';
import { isWriteVerb } from '../../domain/index.js';

/** What the non-interactive branch was asked to do (drives the printed plan). */
export interface NonInteractivePlanInput {
  readonly configPath: string;
  readonly sessionDir: string;
  /** The current on-disk config, when one parses; absent on first run. */
  readonly config?: ValidatedConfig;
}

// Pure helpers (string in, string out — trivially unit-testable, no secrets)

/** A human description block for one endpoint (scope + verbs, no secrets). */
const endpointSummary = (endpoint: ValidatedEndpoint): readonly string[] => {
  const writable = endpoint.verbs.some(isWriteVerb);
  return [
    `  - ${endpoint.name}  [session: ${endpoint.session}]${writable ? '  (WRITABLE)' : ''}`,
    `      verbs:   ${endpoint.verbs.join(', ')}`,
    `      chats:   ${String(endpoint.scope.chats.length)}` +
      `, folders: ${String(endpoint.scope.folders.length)}` +
      `, overrides: ${String(endpoint.scope.chatOverrides.length)}`,
  ];
};

/**
 * The non-interactive plan formatter. Pure + secret-safe: it reads only the already-validated
 * config (which never holds a session string or token) and the paths, so there is nothing to
 * mask beyond never printing those. Emits a deterministic, copy-pasteable plan the caller
 * writes to STDERR before exiting non-zero.
 */
export const formatNonInteractivePlan = (input: NonInteractivePlanInput): string => {
  const lines: string[] = [];
  lines.push('npx secure-telegram-mcp setup — NON-INTERACTIVE (no TTY)');
  lines.push('');
  lines.push(
    'A TTY is required to run the interactive wizard (login + access picker).',
  );
  lines.push('Re-run in a real terminal to configure access.');
  lines.push('');
  lines.push(`  config:  ${input.configPath}`);
  lines.push(`  session: ${input.sessionDir}  (secrets never printed)`);
  lines.push('');

  const endpoints = input.config?.endpoints ?? [];
  if (endpoints.length === 0) {
    lines.push('Current config: none (first run — no endpoints defined yet).');
    return `${lines.join('\n')}\n`;
  }

  lines.push(`Current endpoints (${String(endpoints.length)}):`);
  for (const endpoint of endpoints) {
    for (const line of endpointSummary(endpoint)) lines.push(line);
  }
  return `${lines.join('\n')}\n`;
};
