/**
 * send_reaction use-case — the WRITE engine ordering for the lightweight `react` verb:
 * ACL -> HITL -> quota -> writer -> audit, fail-closed. Pins that a reaction is gated
 * exactly like every other write (a declined confirmation and an exhausted quota both
 * fail closed before the writer), draws the `messages` bucket, and audits allow/deny.
 */
import { describe, it, expect } from 'vitest';
import { ok, err, type Result } from '../../src/shared/index.js';
import {
  DefaultAclEvaluator,
  PeerRefFactory,
  PermissionVerb,
} from '../../src/domain/index.js';
import { AppErrorCode, appError, type AppError } from '../../src/application/errors.js';
import type { WriteUseCaseDeps } from '../../src/application/index.js';
import { makeWriteUseCase, WRITE_SPECS } from '../../src/application/use-cases/write-use-case-impls.js';
import type { EndpointExecutionContext } from '../../src/application/use-cases/context.js';
import {
  buildEndpoint,
  resolvedScope,
  IN_SCOPE,
  NO_DENIED,
  SpyScopedClient,
  FakeClock,
  RecordingAuditLog,
  StubRateLimiter,
  StubConfirmer,
} from './_support.js';

const IN = PeerRefFactory.fromId(IN_SCOPE);
const okVoid: Result<void, AppError> = ok(undefined);

const ctxFor = (
  client: SpyScopedClient,
  confirmWrites: boolean,
): EndpointExecutionContext => ({
  endpoint: buildEndpoint({ verbs: [PermissionVerb.React], confirmWrites }),
  resolvedScope: resolvedScope(),
  overrides: new Map(),
  deniedVerbs: NO_DENIED,
  client,
});

const deps = (over: {
  readonly rateLimiter?: StubRateLimiter;
  readonly confirmer?: StubConfirmer;
  readonly audit?: RecordingAuditLog;
}): WriteUseCaseDeps => ({
  aclEvaluator: new DefaultAclEvaluator(),
  rateLimiter: over.rateLimiter ?? new StubRateLimiter(okVoid),
  confirmer: over.confirmer ?? new StubConfirmer(ok(true)),
  auditLog: over.audit ?? new RecordingAuditLog(),
  clock: new FakeClock(),
});

const CMD = { peer: IN, messageId: 1, emoji: 'A' };

describe('send_reaction write ordering (ACL -> HITL -> quota -> writer -> audit)', () => {
  it('reacts when granted, drawing the `messages` bucket and auditing ALLOW', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const rateLimiter = new StubRateLimiter(okVoid);
    const audit = new RecordingAuditLog();
    const result = await makeWriteUseCase(
      deps({ rateLimiter, audit }),
      WRITE_SPECS.sendReaction,
    ).execute(ctxFor(client, false), CMD);

    expect(result.ok).toBe(true);
    expect(client.calls).toEqual(['resolvePeer', 'sendReaction']);
    expect(rateLimiter.calls).toHaveLength(1);
    expect(rateLimiter.calls[0]?.bucket).toBe('messages');
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.outcome).toBe('allow');
    expect(audit.records[0]?.verb).toBe(PermissionVerb.React);
  });

  it('a declined HITL confirmation fails closed BEFORE quota + writer', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const rateLimiter = new StubRateLimiter(okVoid);
    const audit = new RecordingAuditLog();
    const result = await makeWriteUseCase(
      deps({ rateLimiter, confirmer: new StubConfirmer(ok(false)), audit }),
      WRITE_SPECS.sendReaction,
    ).execute(ctxFor(client, true), CMD);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.ConfirmationRequired);
    // HITL runs before quota (no refund), so a declined reaction spends no quota.
    expect(rateLimiter.calls).toEqual([]);
    expect(client.calls).toEqual(['resolvePeer']);
    expect(audit.records[0]?.outcome).toBe('deny');
  });

  it('an exhausted quota blocks the reaction at the writer (after a positive HITL)', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const rateLimiter = new StubRateLimiter(
      err(appError(AppErrorCode.QuotaExceeded, 'slow down', { retryAfterSeconds: 9 })),
    );
    const result = await makeWriteUseCase(deps({ rateLimiter }), WRITE_SPECS.sendReaction).execute(
      ctxFor(client, true),
      CMD,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.QuotaExceeded);
    expect(client.calls).toEqual(['resolvePeer']); // writer never reached
  });
});
