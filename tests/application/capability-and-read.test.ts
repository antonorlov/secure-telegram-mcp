/**
 * The daemon-wide denied set (kill-switch) and read-tier use-case orchestration
 * (ACL gate + DENY auditing; successful reads are not audited). The per-chat
 * effective-verb SSOT itself is pinned in tests/domain/acl-evaluator.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { ok } from '../../src/shared/index.js';
import { DefaultAclEvaluator, PermissionVerb } from '../../src/domain/index.js';
import { PeerRefFactory } from '../../src/domain/index.js';
import { makeReadUseCase, READ_SPECS } from '../../src/application/use-cases/read-use-case-impls.js';
import {
  daemonDeniedVerbs,
} from '../../src/presentation/mcp/endpoint-stack.js';
import { AppErrorCode } from '../../src/application/errors.js';
import type { EndpointExecutionContext } from '../../src/application/use-cases/context.js';
import {
  buildEndpoint,
  resolvedScope,
  noKillSwitch,
  killSwitch,
  FakeClock,
  RecordingAuditLog,
  SpyScopedClient,
  IN_SCOPE,
  OUT_OF_SCOPE,
  NO_DENIED,
  StubRateLimiter,
} from './_support.js';

describe('daemon-wide denied set (the operator kill-switch)', () => {
  it('daemonDeniedVerbs mirrors the kill-switch exactly', () => {
    expect(daemonDeniedVerbs(noKillSwitch()).size).toBe(0);
    const denied = daemonDeniedVerbs(killSwitch(PermissionVerb.Send));
    expect(denied.has(PermissionVerb.Send)).toBe(true);
    expect(denied.size).toBe(1);
  });
});

describe('GetMessages read use-case', () => {
  const ctx = (client: SpyScopedClient): EndpointExecutionContext => ({
    endpoint: buildEndpoint({ verbs: [PermissionVerb.Read] }),
    resolvedScope: resolvedScope(),
    overrides: new Map(),
    deniedVerbs: NO_DENIED,
    client,
  });

  it('allows an in-scope read and delegates without auditing success', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const audit = new RecordingAuditLog();
    const uc = makeReadUseCase({
      aclEvaluator: new DefaultAclEvaluator(),
      auditLog: audit,
      clock: new FakeClock(),
      rateLimiter: new StubRateLimiter(ok(undefined)),
    }, READ_SPECS.getMessages);

    const result = await uc.execute(ctx(client), {
      peer: PeerRefFactory.fromId(IN_SCOPE),
      limit: 5,
    });

    expect(result.ok).toBe(true);
    expect(client.calls).toEqual(['resolvePeer', 'getMessages']);
    expect(audit.records).toEqual([]); // successful reads are not audited
  });

  it('denies an out-of-scope read and records a DENY audit record', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const audit = new RecordingAuditLog();
    const uc = makeReadUseCase({
      aclEvaluator: new DefaultAclEvaluator(),
      auditLog: audit,
      clock: new FakeClock(),
      rateLimiter: new StubRateLimiter(ok(undefined)),
    }, READ_SPECS.getMessages);

    const result = await uc.execute(ctx(client), {
      peer: PeerRefFactory.fromId(OUT_OF_SCOPE),
      limit: 5,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AclDenied);
    expect(client.calls).toEqual(['resolvePeer']);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.outcome).toBe('deny');
    expect(audit.records[0]?.targetChatId).toBe(OUT_OF_SCOPE.toKey());
  });
});
