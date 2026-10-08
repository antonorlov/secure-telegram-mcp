import { describe, expect, it } from 'vitest';

import { PACKAGE_VERSION } from '../../src/infrastructure/package-info.js';
import { daemonVersionWarning } from '../../src/presentation/cli/daemon-version.js';

describe('daemon version warning', () => {
  it('stays silent when the daemon runs the same version as the CLI', () => {
    expect(daemonVersionWarning('0.3.0', '0.3.0')).toBeUndefined();
    expect(daemonVersionWarning(PACKAGE_VERSION)).toBeUndefined();
  });

  it('names both versions and the way to switch when they differ', () => {
    const warning = daemonVersionWarning('0.2.0', '0.3.0');

    expect(warning).toContain('Telegram MCP 0.2.0 is running, but this CLI is 0.3.0');
    expect(warning).toContain("'npx secure-telegram-mcp stop'");
  });

  it('compares against the installed package by default', () => {
    expect(daemonVersionWarning('0.0.1')).toContain(`this CLI is ${PACKAGE_VERSION}`);
  });
});
