/**
 * Engine FAILURE auditing — the deny records nobody sees on the happy path:
 *  - an UNRESOLVABLE peer fails closed BEFORE the ACL and audits a DENY carrying
 *    the resolver's error code (the request never reaches the reader/writer);
 *  - a writer that fails AFTER every gate (ACL -> HITL -> quota) still audits a
 *    DENY with the failure code, so "a write may have executed" is never silent.
 */
import { describe, it, expect } from 'vitest';
import { ok, err } from '../../src/shared/result.js';
import type { Result } from '../../src/shared/result.js';
import {
  DefaultAclEvaluator,
  PermissionVerb,
  PeerRefFactory,
} from '../../src/domain/index.js';
import { appError, AppErrorCode } from '../../src/application/errors.js';
import type { MessageDto } from '../../src/application/index.js';
import {
  makeReadUseCase,
  READ_SPECS,
} from '../../src/application/use-cases/read-use-case-impls.js';
import {
  makeWriteUseCase,
  WRITE_SPECS,
} from '../../src/application/use-cases/write-use-case-impls.js';
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

const ctxWith = (client: SpyScopedClient): EndpointExecutionContext => ({
  endpoint: buildEndpoint({
    verbs: [PermissionVerb.Read, PermissionVerb.Send],
  }),
  resolvedScope: resolvedScope(),
  overrides: new Map(),
  deniedVerbs: NO_DENIED,
  client,
});

describe('unresolvable peer: deny-audited, never reaches the data layer', () => {
  it('a resolver failure on a read audits a DENY with the resolver error code', async () => {
    const audit = new RecordingAuditLog();
    const client = new SpyScopedClient(
      buildEndpoint({ verbs: [] }).name,
      () => err(appError(AppErrorCode.NotFound, 'peer not in scope')),
    );
    const uc = makeReadUseCase(
      {
        aclEvaluator: new DefaultAclEvaluator(),
        auditLog: audit,
        clock: new FakeClock(),
        rateLimiter: new StubRateLimiter(ok(undefined)),
      },
      READ_SPECS.getMessages,
    );

    const result = await uc.execute(ctxWith(client), { peer: IN, limit: 5 });

    expect(result.ok).toBe(false);
    expect(client.calls).not.toContain('getMessages');
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.outcome).toBe('deny');
    expect(audit.records[0]?.reason).toBe(AppErrorCode.NotFound);
  });
});

describe('post-gate writer failure: still deny-audited', () => {
  it('a writer error after ACL/HITL/quota appends a DENY record with the error code', async () => {
    const audit = new RecordingAuditLog();
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    // Route the failure through the Result channel (the adapter contract):
    const failing = Object.assign(client, {
      sendMessage: (): Promise<Result<MessageDto, ReturnType<typeof appError>>> => {
        client.calls.push('sendMessage');
        return Promise.resolve(
          err(appError(AppErrorCode.GatewayUnavailable, 'connection dropped')),
        );
      },
    });
    const uc = makeWriteUseCase(
      {
        aclEvaluator: new DefaultAclEvaluator(),
        auditLog: audit,
        clock: new FakeClock(),
        rateLimiter: new StubRateLimiter(ok(undefined)),
        confirmer: new StubConfirmer(ok(true)),
      },
      WRITE_SPECS.sendMessage,
    );

    const result = await uc.execute(ctxWith(failing), { peer: IN, text: 'hi' });

    expect(result.ok).toBe(false);
    expect(client.calls).toContain('sendMessage'); // gates passed; the write RAN
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.outcome).toBe('deny');
    expect(audit.records[0]?.reason).toBe(AppErrorCode.GatewayUnavailable);
  });
});
