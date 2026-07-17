/**
 * Scope-lint — STATIC checks over the validated config, at load time before any
 * network access. Two levels:
 *  - 'error' makes the config repository FAIL-CLOSED (refuse to serve).
 *  - 'warn'  is surfaced to the operator but does not block.
 *
 * Live membership is resolved at bind time; if the entire declared scope then
 * resolves empty, `ResolvedScope.create` fails closed. This module stays pure
 * and offline rather than pretending to inspect Telegram state.
 */
import type { ValidatedConfig } from './schema.js';

export type LintLevel = 'error' | 'warn';

export interface LintFinding {
  readonly level: LintLevel;
  readonly endpoint?: string;
  readonly message: string;
}

export const lintConfig = (cfg: ValidatedConfig): readonly LintFinding[] => {
  const findings: LintFinding[] = [];

  for (const ep of cfg.endpoints) {
    const declaredEmpty =
      ep.scope.chats.length === 0 && ep.scope.folders.length === 0;
    // FAIL-CLOSED: an empty declared scope resolves to an empty (or careless
    // allow-all) client. Reject it up front.
    if (declaredEmpty) {
      findings.push({
        level: 'error',
        endpoint: ep.name,
        message:
          'scope declares no chats and no folders — would resolve to an empty allow-list (fail-closed)',
      });
    }

    // Not flagged: write-without-confirmation. HITL is opt-in and defaults OFF
    // by design, so a write endpoint with confirmation off is the normal case.
  }

  return Object.freeze(findings);
};

export const hasLintErrors = (findings: readonly LintFinding[]): boolean =>
  findings.some((f) => f.level === 'error');
