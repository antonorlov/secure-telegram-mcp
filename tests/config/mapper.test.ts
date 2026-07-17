/**
 * Config -> domain mapper: the per-chat verb overrides survive the crossing into
 * the domain as DECLARED (unresolved) overrides on the Endpoint, mirroring
 * how scope chats become PeerRefs. Backward-compat: a config with no overrides
 * maps to an empty declared set (pure group-default behaviour).
 */
import { describe, it, expect } from 'vitest';
import { unwrap } from '../../src/shared/result.js';
import { configSchema, mapConfigToDomain } from '../../src/config/index.js';
import type { MappedConfig } from '../../src/config/index.js';
import type { Endpoint } from '../../src/domain/index.js';

const firstEndpoint = (mapped: MappedConfig): Endpoint => {
  const endpoint = mapped.endpoints[0];
  if (endpoint === undefined) {
    throw new Error('expected at least one mapped endpoint');
  }
  return endpoint;
};

const parse = (cfg: unknown): ReturnType<typeof configSchema.parse> => {
  const parsed = configSchema.safeParse(cfg);
  if (!parsed.success) {
    throw new Error(`fixture did not validate: ${parsed.error.message}`);
  }
  return parsed.data;
};

const base = {
  version: 1 as const,
  endpoints: [
    {
      name: 'support-reader',
      session: 'main',
      tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      scope: { chats: ['me', '-1001234567890'], folders: [] },
      verbs: ['read'],
    },
  ],
};

describe('mapConfigToDomain — per-chat overrides', () => {
  it('carries overrides onto the endpoint as declared (unresolved) PeerRef overrides', () => {
    const mapped = unwrap(
      mapConfigToDomain(
        parse({
          ...base,
          endpoints: [
            {
              ...base.endpoints[0],
              scope: {
                chats: ['me', '-1001234567890'],
                folders: [],
                chatOverrides: {
                  '-1001234567890': ['read', 'send'],
                  me: ['read'],
                },
              },
            },
          ],
        }),
      ),
    );
    const overrides = firstEndpoint(mapped).overrides();
    expect(overrides).toHaveLength(2);

    const idOverride = overrides.find((o) => o.peer.kind === 'id');
    expect(idOverride?.verbs).toEqual(['read', 'send']);
    if (idOverride?.peer.kind === 'id') {
      expect(idOverride.peer.id.toString()).toBe('-1001234567890');
    }

    const meOverride = overrides.find((o) => o.peer.kind === 'me');
    expect(meOverride?.verbs).toEqual(['read']);
  });

  it('BACKWARD-COMPAT: a config with no overrides maps to an empty declared set', () => {
    const mapped = unwrap(mapConfigToDomain(parse(base)));
    expect(firstEndpoint(mapped).overrides()).toEqual([]);
  });

});
