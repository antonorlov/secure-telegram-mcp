/**
 * The contract for the non-TTY, `--no-input` and CI branch of `setup`. The isatty check happens
 * once at entry: a TTY launches the Ink wizard, while a non-TTY must not block on stdin, so it
 * prints the current config and the equivalent flags and exits non-zero.
 */
import type {
  ValidatedConfig,
  ValidatedEndpoint,
} from '../../config/index.js';
import { isWriteVerb } from '../../domain/index.js';

export interface NonInteractivePlanInput {
  readonly configPath: string;
  readonly sessionDir: string;
  readonly config?: ValidatedConfig;
}

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

// Pure and secret-safe: it reads only the already-validated config, which never holds a session
// string or token, so there is nothing to mask. The output is deterministic and copy-pasteable.
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
