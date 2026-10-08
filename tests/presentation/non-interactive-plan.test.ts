/**
 * Non-interactive plan — the NON-TTY branch's deterministic, secret-free output:
 * the current endpoints with their scope summary (chats/folders/overrides counts)
 * and a writable marker, and never any session-dir contents or secrets.
 */
import { describe, it, expect } from 'vitest';

import { formatNonInteractivePlan } from '../../src/presentation/cli/non-interactive-plan.js';
import { configSchema, type ValidatedConfig } from '../../src/config/index.js';

const parse = (raw: unknown): ValidatedConfig => {
  const result = configSchema.safeParse(raw);
  if (!result.success) throw new Error(`bad fixture: ${result.error.message}`);
  return result.data;
};

describe('formatNonInteractivePlan', () => {
  it('renders a first-run notice when there is no config', () => {
    const out = formatNonInteractivePlan({ configPath: '/c.json', sessionDir: '/s' });
    expect(out).toMatch(/non-interactive/i);
    expect(out).toContain('/c.json');
    expect(out).toContain('first run');
  });

  it('renders each endpoint with its verbs and scope-count summary', () => {
    const config = parse({
      version: 1,
      endpoints: [
        {
          name: 'support-reader',
          session: 'main',
          tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          scope: {
            chats: ['@releases', 'me'],
            folders: [3],
            chatOverrides: { '@releases': ['read', 'send'] },
          },
          verbs: ['read'],
        },
      ],
    });

    const out = formatNonInteractivePlan({ configPath: '/c.json', sessionDir: '/s', config });

    expect(out).toContain('support-reader');
    expect(out).toContain('verbs:   read');
    expect(out).toContain('chats:   2, folders: 1, overrides: 1');
  });

  it('flags a writable endpoint and never prints the session dir contents', () => {
    const config = parse({
      version: 1,
      endpoints: [
        {
          name: 'writer',
          session: 'main',
          tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          scope: { chats: ['@some_channel'] },
          verbs: ['read', 'send'],
        },
      ],
    });
    const out = formatNonInteractivePlan({ configPath: '/c.json', sessionDir: '/s', config });
    expect(out).toContain('(WRITABLE)');
    expect(out).toContain('secrets never printed');
  });
});
