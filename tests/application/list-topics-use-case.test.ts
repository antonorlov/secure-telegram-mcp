/**
 * ListTopics read use-case: a topic listing is a single-peer READ — the same
 * resolve -> ACL -> read path as every other read, with denials audited and
 * out-of-scope/verbless requests failing closed BEFORE the reader is reached.
 * A topic is never a security principal: the gate target is the parent chat.
 */
import { describe, it, expect } from 'vitest';
import { ok } from '../../src/shared/index.js';
import {
  DefaultAclEvaluator,
  PermissionVerb,
  PeerRefFactory,
} from '../../src/domain/index.js';
import { makeReadUseCase, READ_SPECS } from '../../src/application/use-cases/read-use-case-impls.js';
import type {
  ListTopicsQuery,
  Page,
  TopicDto,
  UseCase,
} from '../../src/application/index.js';
import { AppErrorCode } from '../../src/application/errors.js';
import type { EndpointExecutionContext } from '../../src/application/use-cases/context.js';
import {
  buildEndpoint,
  resolvedScope,
  deniedVerbs,
  FakeClock,
  RecordingAuditLog,
  SpyScopedClient,
  IN_SCOPE,
  OUT_OF_SCOPE,
  NO_DENIED,
  StubRateLimiter,
} from './_support.js';

const IN_SCOPE_PEER = PeerRefFactory.fromId(IN_SCOPE);
const OUT_OF_SCOPE_PEER = PeerRefFactory.fromId(OUT_OF_SCOPE);

const ctxFor = (
  client: SpyScopedClient,
  verbs: readonly PermissionVerb[],
  denied: ReadonlySet<PermissionVerb> = NO_DENIED,
): EndpointExecutionContext => ({
  endpoint: buildEndpoint({ verbs }),
  resolvedScope: resolvedScope(),
  overrides: new Map(),
  deniedVerbs: denied,
  client,
});

describe('ListTopics read use-case', () => {
  const build = (): { uc: UseCase<ListTopicsQuery, Page<TopicDto>>; audit: RecordingAuditLog } => {
    const audit = new RecordingAuditLog();
    const uc = makeReadUseCase({
      aclEvaluator: new DefaultAclEvaluator(),
      auditLog: audit,
      clock: new FakeClock(),
      rateLimiter: new StubRateLimiter(ok(undefined)),
    }, READ_SPECS.listTopics);
    return { uc, audit };
  };

  it('read-granted, in-scope: reaches the reader and returns the topic page (success not audited)', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const { uc, audit } = build();

    const result = await uc.execute(ctxFor(client, [PermissionVerb.Read]), {
      peer: IN_SCOPE_PEER,
      limit: 20,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toHaveLength(1);
      expect(result.value.items[0]?.topicId).toBe(7);
    }
    expect(client.calls).toEqual(['resolvePeer', 'listTopics']);
    expect(audit.records).toHaveLength(0);
  });

  it('read NOT granted: ACL_DENIED, reader never reached, denial audited', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const { uc, audit } = build();

    const result = await uc.execute(ctxFor(client, [PermissionVerb.Send]), {
      peer: IN_SCOPE_PEER,
      limit: 20,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AclDenied);
    expect(client.calls).toEqual(['resolvePeer']);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.outcome).toBe('deny');
    expect(audit.records[0]?.verb).toBe(PermissionVerb.Read);
  });

  it('out-of-scope parent chat: denied at the scope gate, reader never reached', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const { uc, audit } = build();

    const result = await uc.execute(ctxFor(client, [PermissionVerb.Read]), {
      peer: OUT_OF_SCOPE_PEER,
      limit: 20,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AclDenied);
    expect(client.calls).toEqual(['resolvePeer']);
    expect(audit.records[0]?.outcome).toBe('deny');
  });

  it('kill-switched Read: denied per-chat like every other read', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const { uc } = build();

    const result = await uc.execute(
      ctxFor(client, [PermissionVerb.Read], deniedVerbs(PermissionVerb.Read)),
      { peer: IN_SCOPE_PEER, limit: 20 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AclDenied);
    expect(client.calls).toEqual(['resolvePeer']);
  });
});
