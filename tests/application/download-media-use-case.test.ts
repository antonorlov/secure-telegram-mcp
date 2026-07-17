/**
 * download_media use-case — the read engine's SUCCESS-AUDIT mechanism (media egress
 * must be visible in the audit trail) and its own verb gate (`read_media`).
 *
 *  - a completed download appends ONE allow record (endpoint + read_media + target);
 *  - a plain read (get_messages) does NOT audit on success (reads log only denials),
 *    proving the success-audit is scoped to egress, not all reads;
 *  - a verb-denied download (no read_media grant) fails closed with a DENY record and
 *    never reaches the scoped client.
 */
import { describe, it, expect } from 'vitest';
import { ok } from '../../src/shared/index.js';
import { DefaultAclEvaluator, PeerRefFactory, PermissionVerb } from '../../src/domain/index.js';
import { AppErrorCode } from '../../src/application/errors.js';
import type { ReadUseCaseDeps } from '../../src/application/index.js';
import type { EndpointExecutionContext } from '../../src/application/use-cases/context.js';
import {
  makeReadUseCase,
  READ_SPECS,
} from '../../src/application/use-cases/read-use-case-impls.js';
import {
  buildEndpoint,
  resolvedScope,
  IN_SCOPE,
  NO_DENIED,
  SpyScopedClient,
  FakeClock,
  RecordingAuditLog,
  StubRateLimiter,
} from './_support.js';

const IN = PeerRefFactory.fromId(IN_SCOPE);

const depsWith = (audit: RecordingAuditLog): ReadUseCaseDeps => ({
  aclEvaluator: new DefaultAclEvaluator(),
  auditLog: audit,
  clock: new FakeClock(),
  rateLimiter: new StubRateLimiter(ok(undefined)),
});

const ctxWith = (
  verbs: readonly PermissionVerb[],
  client: SpyScopedClient,
): EndpointExecutionContext => ({
  endpoint: buildEndpoint({ verbs }),
  resolvedScope: resolvedScope(),
  overrides: new Map(),
  deniedVerbs: NO_DENIED,
  client,
});

describe('download_media success-audit (media egress is visible in the audit trail)', () => {
  it('appends ONE allow record with verb read_media on a successful download', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const audit = new RecordingAuditLog();
    const result = await makeReadUseCase(depsWith(audit), READ_SPECS.downloadMedia).execute(
      ctxWith([PermissionVerb.ReadMedia], client),
      { peer: IN, messageId: 1 },
    );

    expect(result.ok).toBe(true);
    expect(client.calls).toContain('downloadMedia');
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.outcome).toBe('allow');
    expect(audit.records[0]?.verb).toBe(PermissionVerb.ReadMedia);
    expect(audit.records[0]?.targetChatId).toBe(IN_SCOPE.toKey());
  });

  it('a plain read (get_messages) does NOT audit on success — egress-only auditing', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const audit = new RecordingAuditLog();
    const result = await makeReadUseCase(depsWith(audit), READ_SPECS.getMessages).execute(
      ctxWith([PermissionVerb.Read], client),
      { peer: IN, limit: 5 },
    );

    expect(result.ok).toBe(true);
    expect(audit.records).toHaveLength(0);
  });

  it('a download WITHOUT the read_media grant fails closed with a DENY, never reaching the client', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const audit = new RecordingAuditLog();
    // read is granted but read_media is NOT (a text-only endpoint).
    const result = await makeReadUseCase(depsWith(audit), READ_SPECS.downloadMedia).execute(
      ctxWith([PermissionVerb.Read], client),
      { peer: IN, messageId: 1 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AclDenied);
    expect(client.calls).not.toContain('downloadMedia');
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.outcome).toBe('deny');
  });
});
