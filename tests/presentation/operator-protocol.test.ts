import { describe, expect, it } from 'vitest';
import { MAX_POLICY_PLAINTEXT_BYTES } from '../../src/infrastructure/bounded-read.js';

import {
  MAX_OPERATOR_FRAME_BYTES,
  OPERATOR_OPERATIONS,
  isOperatorResultFor,
  isSerialOperatorOperation,
  parseOperatorRequest,
  parseOperatorResponse,
} from '../../src/presentation/operator/protocol.js';

const wire = (
  op: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> => ({ v: 1, id: op, op, ...fields });

const request = (
  value: Record<string, unknown>,
): ReturnType<typeof parseOperatorRequest> =>
  parseOperatorRequest(JSON.stringify(value));

const VALID_REQUESTS = [
  wire('status'),
  wire('accounts.list'),
  wire('account.snapshot', { sessionRef: 'main' }),
  wire('login.begin', {
    apiId: 1,
    apiHash: '0123456789abcdef0123456789ABCDEF',
    method: 'qr',
  }),
  wire('login.answer', { flowId: 'flow', promptId: 'prompt', value: '12345' }),
  wire('login.cancel', { flowId: 'flow' }),
  wire('authenticate', {
    source: { kind: 'passphrase', passphrase: 'pin' },
  }),
  wire('policy.apply', { raw: '' }),
  wire('login.commit', {
    flowId: 'flow',
    sessionRef: 'main',
    source: { kind: 'machine' },
  }),
  wire('account.remove', { sessionRef: 'main' }),
  wire('pin.set', {
    current: { kind: 'machine' },
    pin: { kind: 'passphrase', passphrase: 'new-pin' },
  }),
  wire('pin.change', {
    current: { kind: 'keyfile', keyfilePath: '/old' },
    replacement: { kind: 'passphrase', passphrase: 'replacement-pin' },
  }),
  wire('pin.remove', {
    current: { kind: 'passphrase', passphrase: 'pin' },
  }),
  wire('recovery.export', {
    current: { kind: 'keyfile', keyfilePath: '/recovery-key' },
    outputPath: '/backup',
  }),
];

describe('operator protocol', () => {
  it('round-trips every shipped operation through the closed decoder', () => {
    expect(VALID_REQUESTS.map((value) => request(value))).toEqual(VALID_REQUESTS);
    expect(VALID_REQUESTS.map((value) => value['op'])).toEqual(OPERATOR_OPERATIONS);
  });

  it('classifies every operation explicitly and keeps the catalogue immutable', () => {
    const serial = new Set([
      'accounts.list', 'account.snapshot', 'authenticate', 'policy.apply',
      'login.commit', 'account.remove',
      'pin.set', 'pin.change', 'pin.remove', 'recovery.export',
    ]);
    for (const operation of OPERATOR_OPERATIONS) {
      expect(isSerialOperatorOperation(operation)).toBe(serial.has(operation));
    }
    expect(Object.isFrozen(OPERATOR_OPERATIONS)).toBe(true);
    expect(() => (OPERATOR_OPERATIONS as string[]).push('status')).toThrow(TypeError);
  });

  it('refuses unknown operations, versions, fields, and malformed JSON', () => {
    for (const value of VALID_REQUESTS) {
      expect(request({ ...value, unexpected: true })).toBeUndefined();
    }
    expect(request(wire('invoke'))).toBeUndefined();
    expect(request({ ...wire('status'), v: 2 })).toBeUndefined();
    expect(request({ ...wire('status'), id: '' })).toBeUndefined();
    for (const line of ['null', '[]', 'not json']) {
      expect(parseOperatorRequest(line)).toBeUndefined();
    }
  });

  it('accepts credential sources only where their posture permits them', () => {
    const protectedSources = [
      { kind: 'passphrase', passphrase: 'pin' },
      { kind: 'keyfile', keyfilePath: '/key' },
    ];
    for (const source of protectedSources) {
      expect(request(wire('authenticate', { source }))).toBeDefined();
      expect(
        request(wire('login.commit', {
          flowId: 'flow', sessionRef: 'main', source,
        })),
      ).toBeDefined();
    }
    expect(
      request(wire('authenticate', {
        source: { ...protectedSources[0], unexpected: true },
      })),
    ).toBeUndefined();
    expect(request(wire('authenticate', { source: { kind: 'machine' } })))
      .toBeUndefined();
    // The retired 'recovery' source kind is no longer accepted vocabulary —
    // a recovery keyfile unlocks through the 'keyfile' channel instead.
    expect(
      request(wire('authenticate', {
        source: { kind: 'recovery', keyfilePath: '/recovery' },
      })),
    ).toBeUndefined();
    expect(
      request(wire('pin.set', {
        current: protectedSources[0],
        pin: protectedSources[1],
      })),
    ).toBeUndefined();
  });

  it('enforces character and UTF-8 byte boundaries exactly', () => {
    expect(request({ ...wire('status'), id: 'i'.repeat(64) })).toBeDefined();
    expect(request({ ...wire('status'), id: 'i'.repeat(65) })).toBeUndefined();

    const secretAtLimit = 'é'.repeat(2048);
    expect(request(wire('authenticate', {
      source: { kind: 'passphrase', passphrase: secretAtLimit },
    }))).toBeDefined();
    expect(request(wire('authenticate', {
      source: { kind: 'passphrase', passphrase: `${secretAtLimit}x` },
    }))).toBeUndefined();

    const identifierAtLimit = '🚀'.repeat(32);
    expect(request(wire('account.snapshot', {
      sessionRef: identifierAtLimit,
    }))).toBeDefined();
    expect(request(wire('account.snapshot', {
      sessionRef: `${identifierAtLimit}x`,
    }))).toBeUndefined();
  });

  it('pins Telegram credential and policy-frame bounds', () => {
    const login = (
      apiId: number,
      apiHash = '0'.repeat(32),
    ): ReturnType<typeof parseOperatorRequest> =>
      request(wire('login.begin', { apiId, apiHash, method: 'phone' }));
    expect(login(1)).toBeDefined();
    expect(login(2_147_483_647)).toBeDefined();
    expect(login(0)).toBeUndefined();
    expect(login(2_147_483_648)).toBeUndefined();
    expect(login(1, 'g'.repeat(32))).toBeUndefined();
    expect(login(1, '0'.repeat(31))).toBeUndefined();

    expect(request(wire('policy.apply', {
      raw: 'x'.repeat(MAX_POLICY_PLAINTEXT_BYTES),
    }))).toBeDefined();
    expect(request(wire('policy.apply', {
      raw: 'x'.repeat(MAX_POLICY_PLAINTEXT_BYTES + 1),
    }))).toBeUndefined();
  });

  it('carries a maximally-sized escaped policy inside the wire ceiling', () => {
    const raw = `[${'\n'.repeat(MAX_POLICY_PLAINTEXT_BYTES - 2)}]`;
    expect(JSON.parse(raw)).toEqual([]);
    const frame = JSON.stringify(wire('policy.apply', { raw }));
    expect(Buffer.byteLength(frame, 'utf8')).toBeLessThanOrEqual(
      MAX_OPERATOR_FRAME_BYTES,
    );
    expect(parseOperatorRequest(frame)).toMatchObject({ op: 'policy.apply', raw });
  });

  it('decodes only exact, bounded response and event shapes', () => {
    const responses = [
      { v: 1, id: '1', ok: true, result: { posture: 'smooth', locked: false, hasAccounts: true } },
      { v: 1, id: '2', ok: true, result: { accounts: [{ sessionRef: 'main', label: 'Jose 🚀' }] } },
      { v: 1, id: '3', ok: true, result: { chats: [], folders: [] } },
      { v: 1, id: '4', ok: true, result: { authenticated: true } },
      { v: 1, id: '5', ok: true, result: { digest: 'a'.repeat(64) } },
      { v: 1, id: '6', ok: true, result: { flowId: '6', account: { id: '1', displayName: 'Ada', username: 'ada_user' } } },
      { v: 1, id: '7', ok: true, result: { sessionRef: 'main' } },
      { v: 1, id: '8', ok: true, result: { accepted: true } },
      { v: 1, id: '9', ok: true, result: { changed: true } },
      { v: 1, id: '10', ok: false, error: 'refused' },
      { v: 1, id: '11', event: 'login.qr', url: 'tg://login', expiresInSeconds: 30 },
      { v: 1, id: '12', event: 'login.prompt', promptId: '1', kind: 'password', hint: '2FA' },
    ];
    for (const value of responses) {
      expect(parseOperatorResponse(JSON.stringify(value))).toEqual(value);
      expect(
        parseOperatorResponse(JSON.stringify({ ...value, unexpected: true })),
      ).toBeUndefined();
    }

    for (const value of [
      null,
      [],
      { v: 1, id: '1', ok: true, result: { changed: false } },
      { v: 1, id: '1', ok: true, result: { outputPath: '/tmp/recovery' } },
      { v: 1, id: '1', ok: true, result: { digest: 'short' } },
      { v: 1, id: '1', event: 'login.prompt', promptId: '1', kind: 'raw' },
      { v: 1, id: 'x'.repeat(65), ok: false, error: 'bad' },
    ]) {
      expect(parseOperatorResponse(JSON.stringify(value))).toBeUndefined();
    }
  });

  it('correlates success payloads with their request operation', () => {
    const changed = { changed: true } as const;
    const status = {
      posture: 'hardened' as const,
      locked: false,
      hasAccounts: true,
    };
    expect(isOperatorResultFor('pin.change', changed)).toBe(true);
    expect(isOperatorResultFor('status', changed)).toBe(false);
    expect(isOperatorResultFor('status', status)).toBe(true);
    expect(isOperatorResultFor('account.remove', status)).toBe(false);
  });
});
