import { describe, expect, it } from 'vitest';

import {
  PolicyApplicationService,
  type ConfigDocumentParser,
  type LoadedConfiguration,
  type SealedPolicyStore,
  type SessionGate,
} from '../../src/application/index.js';
import { AppErrorCode, appError } from '../../src/application/index.js';
import { err, ok } from '../../src/shared/index.js';

const loaded: LoadedConfiguration = {
  endpoints: [],
  killSwitch: { disabledVerbs: new Set() },
};

describe('PolicyApplicationService', () => {
  it('validates, seals exact bytes, then publishes', async () => {
    const order: string[] = [];
    let sealed = '';
    const parser: ConfigDocumentParser = {
      loadFromParsed: () => {
        order.push('validate');
        return ok(loaded);
      },
    };
    const store: SealedPolicyStore = {
      loadPolicy: () => Promise.resolve(ok(undefined)),
      savePolicy: (bytes) => {
        order.push('seal');
        sealed = bytes.toString('utf8');
        return Promise.resolve(ok(undefined));
      },
    };
    const gate = {
      isUnlocked: () => true,
      publishValidated: (config: LoadedConfiguration, hook?: () => void) => {
        expect(config).toBe(loaded);
        order.push('publish');
        hook?.();
      },
    } as unknown as SessionGate;
    const service = new PolicyApplicationService(parser, store, gate);

    const result = await service.apply(Buffer.from('{"version":1}'), () => {
      order.push('retire');
    });

    expect(result.ok).toBe(true);
    expect(sealed).toBe('{"version":1}');
    expect(order).toEqual(['validate', 'seal', 'publish', 'retire']);
  });

  it('FAILS CLOSED while locked: SessionLocked, and neither parser nor store is touched', async () => {
    const calls: string[] = [];
    const parser: ConfigDocumentParser = {
      loadFromParsed: () => { calls.push('validate'); return ok(loaded); },
    };
    const store: SealedPolicyStore = {
      loadPolicy: () => Promise.resolve(ok(undefined)),
      savePolicy: () => { calls.push('seal'); return Promise.resolve(ok(undefined)); },
    };
    const gate = {
      isUnlocked: () => false,
      publishValidated: () => { calls.push('publish'); },
    } as unknown as SessionGate;

    const result = await new PolicyApplicationService(parser, store, gate).apply(
      Buffer.from('{"version":1}'),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.SessionLocked);
    expect(calls).toEqual([]);
  });

  it('rejects non-JSON bytes with Validation before validation or sealing', async () => {
    const calls: string[] = [];
    const parser: ConfigDocumentParser = {
      loadFromParsed: () => { calls.push('validate'); return ok(loaded); },
    };
    const store: SealedPolicyStore = {
      loadPolicy: () => Promise.resolve(ok(undefined)),
      savePolicy: () => { calls.push('seal'); return Promise.resolve(ok(undefined)); },
    };
    const gate = {
      isUnlocked: () => true,
      publishValidated: () => { calls.push('publish'); },
    } as unknown as SessionGate;

    const result = await new PolicyApplicationService(parser, store, gate).apply(
      Buffer.from('not json {'),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.Validation);
    expect(calls).toEqual([]);
  });

  it('a parser rejection NEVER seals or publishes (invalid config cannot become policy)', async () => {
    const calls: string[] = [];
    const parser: ConfigDocumentParser = {
      loadFromParsed: () => err(appError(AppErrorCode.Validation, 'bad config')),
    };
    const store: SealedPolicyStore = {
      loadPolicy: () => Promise.resolve(ok(undefined)),
      savePolicy: () => { calls.push('seal'); return Promise.resolve(ok(undefined)); },
    };
    const gate = {
      isUnlocked: () => true,
      publishValidated: () => { calls.push('publish'); },
    } as unknown as SessionGate;

    const result = await new PolicyApplicationService(parser, store, gate).apply(
      Buffer.from('{"version":1}'),
    );

    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('a seal (savePolicy) failure NEVER publishes: the enforced menu keeps the old policy', async () => {
    const calls: string[] = [];
    const parser: ConfigDocumentParser = {
      loadFromParsed: () => ok(loaded),
    };
    const store: SealedPolicyStore = {
      loadPolicy: () => Promise.resolve(ok(undefined)),
      savePolicy: () =>
        Promise.resolve(err(appError(AppErrorCode.GatewayUnavailable, 'disk full'))),
    };
    const gate = {
      isUnlocked: () => true,
      publishValidated: () => { calls.push('publish'); },
    } as unknown as SessionGate;

    const result = await new PolicyApplicationService(parser, store, gate).apply(
      Buffer.from('{"version":1}'),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.GatewayUnavailable);
    expect(calls).toEqual([]);
  });
});
