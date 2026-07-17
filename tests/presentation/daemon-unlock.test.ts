/**
 * HARDENED unlock path — the pure lock policy. (The masked PIN prompt is pinned
 * in pin-prompt.test.ts; verifyUnlock in the encrypted-store suite.)
 */
import { describe, it, expect } from 'vitest';

import {
  isLockedWithoutPin,
  SESSION_LOCKED_MESSAGE,
} from '../../src/presentation/mcp/daemon.js';

describe('lock policy', () => {
  it('locks ONLY hardened-without-PIN-channel', () => {
    expect(isLockedWithoutPin('hardened', 'machine')).toBe(true);
    expect(isLockedWithoutPin('hardened', 'passphrase')).toBe(false);
    expect(isLockedWithoutPin('smooth', 'machine')).toBe(false);
    expect(isLockedWithoutPin('none', 'machine')).toBe(false);
    expect(SESSION_LOCKED_MESSAGE).toBe(
      "Telegram MCP is locked. Run 'npx secure-telegram-mcp start' in a terminal, then retry.",
    );
    expect(SESSION_LOCKED_MESSAGE.toLowerCase()).not.toContain('daemon');
  });
});
