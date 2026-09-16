/**
 * Static checks over the validated config at load time, before any network access. 'error'
 * makes the config repository fail closed; 'warn' only surfaces to the operator. Live
 * membership is resolved later, at bind time.
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
    // FAIL-CLOSED: an empty declared scope would resolve to an empty or careless allow-all
    // client.
    if (declaredEmpty) {
      findings.push({
        level: 'error',
        endpoint: ep.name,
        message:
          'scope declares no chats and no folders — would resolve to an empty allow-list (fail-closed)',
      });
    }

    // Write-without-confirmation is deliberately not flagged: HITL is opt-in and defaults off.
  }

  return Object.freeze(findings);
};

export const hasLintErrors = (findings: readonly LintFinding[]): boolean =>
  findings.some((f) => f.level === 'error');
