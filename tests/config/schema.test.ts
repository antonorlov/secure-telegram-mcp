import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { configSchema, lintConfig, hasLintErrors } from '../../src/config/index.js';
import { ChatId, PeerRefFactory, type PeerRef } from '../../src/domain/index.js';
import { unwrap } from '../../src/shared/result.js';

/** Domain id ref — what the schema transforms emit for a numeric shorthand. */
const idRef = (raw: string): PeerRef =>
  PeerRefFactory.fromId(unwrap(ChatId.fromString(raw)));

const validConfig = {
  version: 1,
  endpoints: [
    {
      name: 'support-reader',
      session: 'main',
      tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      scope: {
        chats: ['me', '@somechannel', '-1001234567890'],
        folders: [2, 'Work'],
      },
      verbs: ['read', 'send'],
    },
  ],
};

describe('configSchema', () => {
  it('REJECTS a malformed tokenHash (the API-key gate is shape-checked fail-closed)', () => {
    const withHash = (tokenHash: string): unknown => ({
      ...validConfig,
      endpoints: [{ ...validConfig.endpoints[0], tokenHash }],
    });
    // no salt separator / uppercase hex / wrong salt length / wrong hash length
    for (const bad of [
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'aaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef',
    ]) {
      expect(configSchema.safeParse(withHash(bad)).success).toBe(false);
    }
  });

  it('killSwitch defaults to an EMPTY denied set and rejects unknown verbs', () => {
    const parsed = configSchema.safeParse(validConfig);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.killSwitch.disabledVerbs).toEqual([]);
    }
    expect(
      configSchema.safeParse({
        ...validConfig,
        killSwitch: { disabledVerbs: ['superuser'] },
      }).success,
    ).toBe(false);
  });

  it('the SHIPPED example config validates verbatim (copy-paste must never fail the schema)', () => {
    // telegram-mcp.config.example.json is what the README points new users at;
    // it must always satisfy the strict schema (including required tokenHash —
    // its placeholder digests parse but match no real key, so a pasted example
    // fails closed at the API-key gate rather than at config load).
    const example: unknown = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', 'telegram-mcp.config.example.json'),
        'utf8',
      ),
    );
    const parsed = configSchema.safeParse(example);
    expect(parsed.success).toBe(true);
  });

  it('parses a valid config and normalises chat/folder shorthands to domain refs', () => {
    const parsed = configSchema.safeParse(validConfig);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const ep = parsed.data.endpoints[0];
      expect(ep.scope.chats).toEqual([
        { kind: 'me' },
        { kind: 'username', username: 'somechannel' },
        idRef('-1001234567890'),
      ]);
      expect(ep.scope.folders).toEqual([
        { kind: 'id', id: 2 },
        { kind: 'title', title: 'Work' },
      ]);
      // HITL is opt-in per endpoint; defaults to off.
      expect(ep.hitl.confirmWrites).toBe(false);
    }
  });

  it('rejects a domain-invalid chat ref at the schema (factory validation runs in the transform)', () => {
    // '@x' is valid shorthand grammar but too short for a real Telegram
    // username; chat id 0 is never a valid peer. Both must fail the SCHEMA now
    // that the transforms build refs through the domain factories.
    for (const chat of ['@x', '0']) {
      const bad = {
        ...validConfig,
        endpoints: [
          {
            ...validConfig.endpoints[0],
            scope: { chats: [chat], folders: [] },
          },
        ],
      };
      expect(configSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects an unknown verb', () => {
    const bad = {
      ...validConfig,
      endpoints: [{ ...validConfig.endpoints[0], verbs: ['read', 'nuke'] }],
    };
    expect(configSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects duplicate endpoint names', () => {
    const dup = {
      version: 1,
      endpoints: [validConfig.endpoints[0], validConfig.endpoints[0]],
    };
    expect(configSchema.safeParse(dup).success).toBe(false);
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(configSchema.safeParse({ ...validConfig, extra: 1 }).success).toBe(
      false,
    );
  });
});

describe('configSchema — maxDownloadBytes (global download egress cap)', () => {
  it('accepts a positive integer override', () => {
    const parsed = configSchema.safeParse({
      ...validConfig,
      maxDownloadBytes: 10 * 1024 * 1024,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.maxDownloadBytes).toBe(10 * 1024 * 1024);
    }
  });

  it('is undefined when absent (the gateway applies its runtime default)', () => {
    const parsed = configSchema.safeParse(validConfig);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.maxDownloadBytes).toBeUndefined();
    }
  });

  it('rejects a non-positive or non-integer cap', () => {
    for (const bad of [0, -1, 1.5]) {
      expect(
        configSchema.safeParse({ ...validConfig, maxDownloadBytes: bad }).success,
      ).toBe(false);
    }
  });

  it('rejects a cap over the 4 GiB sanity ceiling', () => {
    expect(
      configSchema.safeParse({
        ...validConfig,
        maxDownloadBytes: 5 * 1024 * 1024 * 1024,
      }).success,
    ).toBe(false);
  });
});

describe('configSchema — per-chat verb overrides (additive, non-breaking)', () => {
  it('BACKWARD-COMPAT: a config without chatOverrides validates and defaults to []', () => {
    const parsed = configSchema.safeParse(validConfig);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.endpoints[0].scope.chatOverrides).toEqual([]);
    }
  });

  it('normalises the on-disk record to override entries keyed by the same chat language', () => {
    const parsed = configSchema.safeParse({
      ...validConfig,
      endpoints: [
        {
          ...validConfig.endpoints[0],
          scope: {
            chats: ['me', '@somechannel', '-1001234567890'],
            folders: [],
            chatOverrides: {
              '-1001234567890': ['read', 'send'],
              me: ['read'],
            },
          },
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.endpoints[0].scope.chatOverrides).toEqual([
        { peer: idRef('-1001234567890'), verbs: ['read', 'send'] },
        { peer: { kind: 'me' }, verbs: ['read'] },
      ]);
    }
  });

  it('rejects an unknown verb inside an override', () => {
    const bad = {
      ...validConfig,
      endpoints: [
        {
          ...validConfig.endpoints[0],
          scope: { chats: ['me'], folders: [], chatOverrides: { me: ['nuke'] } },
        },
      ],
    };
    expect(configSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty override verb list (an override must grant at least one verb)', () => {
    const bad = {
      ...validConfig,
      endpoints: [
        {
          ...validConfig.endpoints[0],
          scope: { chats: ['me'], folders: [], chatOverrides: { me: [] } },
        },
      ],
    };
    expect(configSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an invalid override KEY (same chat-ref grammar as scope.chats)', () => {
    const bad = {
      ...validConfig,
      endpoints: [
        {
          ...validConfig.endpoints[0],
          scope: {
            chats: ['me'],
            folders: [],
            chatOverrides: { 'not a chat ref': ['read'] },
          },
        },
      ],
    };
    expect(configSchema.safeParse(bad).success).toBe(false);
  });

  it('ROUND-TRIP: arbitrary override KEYS survive validation (no key is dropped or clobbered)', () => {
    const keys = {
      me: ['read'],
      '@reviewers': ['read', 'send'],
      '-1009999999999': ['read', 'forward'],
    } as const;
    const parsed = configSchema.safeParse({
      ...validConfig,
      endpoints: [
        {
          ...validConfig.endpoints[0],
          scope: { chats: ['me'], folders: [], chatOverrides: keys },
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const overrides = parsed.data.endpoints[0].scope.chatOverrides;
      // every authored key is preserved (round-trip-stable identity set).
      expect(overrides).toHaveLength(Object.keys(keys).length);
      expect(overrides.map((o) => o.peer)).toEqual(
        expect.arrayContaining([
          { kind: 'me' },
          { kind: 'username', username: 'reviewers' },
          idRef('-1009999999999'),
        ]),
      );
    }
  });
});

describe('scope-lint', () => {
  it('flags an endpoint with an empty declared scope as an error', () => {
    const parsed = configSchema.safeParse({
      version: 1,
      endpoints: [
        {
          name: 'empty',
          session: 'main',
          tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          scope: { chats: [], folders: [] },
          verbs: ['read'],
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const findings = lintConfig(parsed.data);
      expect(hasLintErrors(findings)).toBe(true);
    }
  });

  it('does NOT warn for writes with confirmWrites off (opt-in default)', () => {
    const parsed = configSchema.safeParse({
      version: 1,
      endpoints: [
        {
          name: 'writer',
          session: 'main',
          tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          scope: { chats: ['me'], folders: [] },
          verbs: ['send'],
          hitl: { confirmWrites: false },
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const findings = lintConfig(parsed.data);
      // HITL is opt-in / default-off by design, so write-without-confirmation is
      // the sanctioned normal case and is NOT linted.
      expect(findings.some((f) => f.level === 'warn')).toBe(false);
      expect(hasLintErrors(findings)).toBe(false);
    }
  });
});
