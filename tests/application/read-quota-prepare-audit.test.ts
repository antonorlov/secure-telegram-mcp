/**
 * 2026-07-08 fix-pass behaviours of the use-case templates:
 *  - READ-SIDE QUOTA (#3): search_messages draws from the `searches` bucket —
 *    one unit for a peered search, bounded worst-case fan-out units for an
 *    un-peered page — AFTER the ACL gate (a denied request spends nothing), and
 *    a refusal is audited as a DENY without reaching the reader.
 *  - PREPARE AUDIT (#4c): prepare_media appends an allow/deny audit record
 *    like every other write-tier op (no quota, no HITL, no raw path).
 *  - FORWARD HITL DESTINATION (LOW): a `username`/`me` forward destination
 *    reaches the confirmer as the RESOLVED canonical id, never as "no target".
 */
import { describe, it, expect } from 'vitest';
import { ok, err, unwrap } from '../../src/shared/result.js';
import {
  DefaultAclEvaluator,
  PermissionVerb,
  PeerRefFactory,
  ResolvedScope,
} from '../../src/domain/index.js';
import {
  MAX_SEARCH_FANOUT_CALLS,
  makeReadUseCase,
  READ_SPECS,
} from '../../src/application/index.js';
import {
  makeWriteUseCase,
  WRITE_SPECS,
  createPrepareMediaUseCase,
} from '../../src/application/use-cases/write-use-case-impls.js';
import type {
  MessageDto,
  Page,
  SearchMessagesQuery,
  UseCase,
} from '../../src/application/index.js';
import { appError, AppErrorCode } from '../../src/application/errors.js';
import type { EndpointExecutionContext } from '../../src/application/use-cases/context.js';
import {
  buildEndpoint,
  chatId,
  FakeClock,
  IN_SCOPE,
  NO_DENIED,
  RecordingAuditLog,
  SpyScopedClient,
  StubConfirmer,
  StubRateLimiter,
} from './_support.js';

const IN_SCOPE_PEER = PeerRefFactory.fromId(IN_SCOPE);
const HITL_ON = true;

/** A 3-chat resolved scope so fan-out weighting is distinguishable from 1. */
const threeChatScope = (): ResolvedScope =>
  unwrap(ResolvedScope.create([chatId(100n), chatId(101n), chatId(102n)]));

const ctxFor = (
  client: SpyScopedClient,
  verbs: readonly PermissionVerb[],
): EndpointExecutionContext => ({
  endpoint: buildEndpoint({ verbs }),
  resolvedScope: threeChatScope(),
  overrides: new Map(),
  deniedVerbs: NO_DENIED,
  client,
});

describe('search_messages read-side quota (#3)', () => {
  const build = (
    limiter: StubRateLimiter,
  ): { uc: UseCase<SearchMessagesQuery, Page<MessageDto>>; audit: RecordingAuditLog } => {
    const audit = new RecordingAuditLog();
    const uc = makeReadUseCase({
      aclEvaluator: new DefaultAclEvaluator(),
      auditLog: audit,
      clock: new FakeClock(),
      rateLimiter: limiter,
    }, READ_SPECS.searchMessages);
    return { uc, audit };
  };

  it('an UN-PEERED search reserves its bounded worst-case call count', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const limiter = new StubRateLimiter(ok(undefined));
    const { uc } = build(limiter);

    const result = await uc.execute(ctxFor(client, [PermissionVerb.Read]), {
      query: 'q',
      limit: 10,
    });

    expect(result.ok).toBe(true);
    expect(limiter.calls).toHaveLength(1);
    expect(limiter.calls[0]?.bucket).toBe('searches');
    expect(limiter.calls[0]?.units).toBe(3); // one per in-scope chat
    expect(client.calls).toContain('searchMessages');
  });

  it('caps a large-scope reservation at the adapter fan-out budget', async () => {
    const peers = Array.from({ length: MAX_SEARCH_FANOUT_CALLS + 3 }, (_, index) =>
      chatId(BigInt(1_000 + index)),
    );
    const scope = unwrap(ResolvedScope.create(peers));
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const limiter = new StubRateLimiter(ok(undefined));
    const { uc } = build(limiter);

    const result = await uc.execute(
      { ...ctxFor(client, [PermissionVerb.Read]), resolvedScope: scope },
      { query: 'q', limit: 10 },
    );

    expect(result.ok).toBe(true);
    expect(limiter.calls[0]?.units).toBe(MAX_SEARCH_FANOUT_CALLS);
  });

  it('a PEERED search reserves exactly one unit', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const limiter = new StubRateLimiter(ok(undefined));
    const { uc } = build(limiter);

    const result = await uc.execute(ctxFor(client, [PermissionVerb.Read]), {
      query: 'q',
      peer: IN_SCOPE_PEER,
      limit: 10,
    });

    expect(result.ok).toBe(true);
    expect(limiter.calls[0]?.units).toBe(1);
  });

  it('a quota refusal fails closed BEFORE the reader and audits a DENY', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const limiter = new StubRateLimiter(
      err(
        appError(AppErrorCode.QuotaExceeded, 'searches exhausted', {
          retryAfterSeconds: 7,
        }),
      ),
    );
    const { uc, audit } = build(limiter);

    const result = await uc.execute(ctxFor(client, [PermissionVerb.Read]), {
      query: 'q',
      limit: 10,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.QuotaExceeded);
    }
    expect(client.calls).not.toContain('searchMessages');
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.outcome).toBe('deny');
    expect(audit.records[0]?.reason).toBe(AppErrorCode.QuotaExceeded);
  });

  it('the quota gate runs AFTER the ACL: a verb-denied search spends NOTHING', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const limiter = new StubRateLimiter(ok(undefined));
    const { uc } = build(limiter);

    const result = await uc.execute(ctxFor(client, []), {
      query: 'q',
      limit: 10,
    });

    expect(result.ok).toBe(false);
    expect(limiter.calls).toHaveLength(0);
  });
});

describe('prepare_media audit (#4c)', () => {
  const build = (): { uc: ReturnType<typeof createPrepareMediaUseCase>; audit: RecordingAuditLog } => {
    const audit = new RecordingAuditLog();
    const uc = createPrepareMediaUseCase({
      aclEvaluator: new DefaultAclEvaluator(),
      auditLog: audit,
      clock: new FakeClock(),
      rateLimiter: new StubRateLimiter(ok(undefined)),
    });
    return { uc, audit };
  };

  it('a successful prepare appends an ALLOW record (and never the raw path)', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const { uc, audit } = build();

    const result = await uc.execute(ctxFor(client, [PermissionVerb.Send]), {
      localPath: '/media/photo.jpg',
    });

    expect(result.ok).toBe(true);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.outcome).toBe('allow');
    expect(audit.records[0]?.verb).toBe(PermissionVerb.Send);
    expect(JSON.stringify(audit.records[0])).not.toContain('photo.jpg');
  });

  it('an ACL-denied prepare appends a DENY record and never reaches the client', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const { uc, audit } = build();

    const result = await uc.execute(ctxFor(client, [PermissionVerb.Read]), {
      localPath: '/media/photo.jpg',
    });

    expect(result.ok).toBe(false);
    expect(client.calls).not.toContain('prepareMedia');
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.outcome).toBe('deny');
  });
});

describe('forward HITL destination fallback (LOW)', () => {
  it('a username destination reaches the confirmer as the RESOLVED canonical id', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const confirmer = new StubConfirmer(ok(true));
    const audit = new RecordingAuditLog();
    const uc = makeWriteUseCase({
      aclEvaluator: new DefaultAclEvaluator(),
      rateLimiter: new StubRateLimiter(ok(undefined)),
      confirmer,
      auditLog: audit,
      clock: new FakeClock(),
    }, WRITE_SPECS.forwardMessage);
    const ctx: EndpointExecutionContext = {
      ...ctxFor(client, [PermissionVerb.Read, PermissionVerb.Forward]),
      endpoint: buildEndpoint({
        // Forward requires READ on the source + FORWARD on the destination.
        verbs: [PermissionVerb.Read, PermissionVerb.Forward],
        confirmWrites: HITL_ON,
      }),
    };

    const result = await uc.execute(ctx, {
      fromPeer: IN_SCOPE_PEER,
      toPeer: unwrap(PeerRefFactory.fromUsername('someone')),
      messageIds: [42],
    });

    expect(result.ok).toBe(true);
    // The approver sees WHERE it goes: the destination resolved by the scoped
    // layer (SpyScopedClient resolves non-id peers to the in-scope chat).
    expect(confirmer.calls).toHaveLength(1);
    expect(confirmer.calls[0]?.targetChatId).toBe(IN_SCOPE.toKey());
  });
});
