import { describe, expect, it } from 'vitest';

import { daemonSpawnEnvironment } from '../../src/infrastructure/daemon-environment.js';

describe('daemonSpawnEnvironment', () => {
  it('drops MCP endpoint authority without mutating the parent environment', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      TELEGRAM_MCP_CONFIG: '/state/config.json',
      TELEGRAM_MCP_ENDPOINT: 'reader',
      TELEGRAM_MCP_ENDPOINT_TOKEN: 'tgmcp_plaintext_secret',
    };

    expect(daemonSpawnEnvironment(source)).toEqual({
      PATH: '/usr/bin',
      TELEGRAM_MCP_CONFIG: '/state/config.json',
    });
    expect(source['TELEGRAM_MCP_ENDPOINT_TOKEN']).toBe(
      'tgmcp_plaintext_secret',
    );
  });
});
