/**
 * forward_message — SCOPE & VERB enforcement (the differentiator under test).
 *
 * `forward` is the one tool that addresses TWO peers at once: a SOURCE to read
 * from and a DESTINATION to send to. The product invariants this suite pins:
 *
 *   - SAME-GROUP ONLY (#1): an endpoint is bound to exactly ONE virtual group ->
 *     ONE resolved allow-list. BOTH `fromPeer` (read on source) and `toPeer`
 *     (send on destination) are scope-checked against that single resolved
 *     scope. There is no second scope to reach into, so a cross-GROUP forward is
 *     structurally impossible — you can only forward within the bound group.
 *   - CROSS-SCOPE REJECTED (#1, fail-closed): if EITHER end is outside the
 *     resolved allow-list the request is denied at the ACL chokepoint BEFORE any
 *     quota is spent and BEFORE the scoped writer is ever reached.
 *   - VERB-GATED (#3/#4): `forward` is its own least-privilege verb. The
 *     verb-gated registry lists `forward_message` ONLY for an endpoint that
 *     grants `forward` (the menu IS the ACL); and even if the handler were
 *     reached on a non-`forward` endpoint, the use-case ACL denies at the
 *     verb-gate (defense in depth).
 *   - ANTI-BAN (#7): a permitted forward draws the dedicated `forwards` bucket.
 *   - HITL (#8): forward is a WRITE; when the endpoint policy requires
 *     confirmation, a decline fails the write closed.
 *
 * We drive the REAL presentation tool (`createForwardMessageTool`) over the REAL
 * use-case orchestration (the shared write engine + forward spec) with the REAL pure ACL
 * evaluator (`DefaultAclEvaluator`); only the side-effecting PORTS (rate limiter,
 * confirmer, audit, clock, scoped client) are fakes. That way the assertions are
 * about the actual security chokepoint, not a re-implementation of it.
 */
import { describe, it, expect } from 'vitest';
import { ok, err, unwrap, type Result } from '../../src/shared/result.js';
import {
  DefaultAclEvaluator,
  DomainErrorCode,
  PeerRefFactory,
  PermissionVerb,
  ResolvedScope,
} from '../../src/domain/index.js';
import {
  AppErrorCode,
  appError,
  type AppError,
  type EndpointExecutionContext,
  type ForwardMessageCommand,
  type ForwardResultDto,
  type UseCase,
} from '../../src/application/index.js';
import {
  makeWriteUseCase,
  WRITE_SPECS,
} from '../../src/application/use-cases/write-use-case-impls.js';
import { createForwardMessageTool } from '../../src/presentation/mcp/tools/forwardMessage.js';
import { buildEndpointServer } from '../../src/presentation/mcp/server.js';
import type { ToolOutput } from '../../src/presentation/mcp/registry.js';
import {
  chatId,
  buildEndpoint,
  resolvedScope,
  FakeClock,
  RecordingAuditLog,
  StubRateLimiter,
  StubConfirmer,
  SpyScopedClient,
  NO_DENIED,
} from '../application/_support.js';

// --- fixture peers --------------------------------------------------------
// Two distinct chats that live in the SAME virtual group (one resolved scope)…
const SRC_IN_GROUP = chatId(100n);
const DST_IN_GROUP = chatId(200n);
// …and one chat that belongs to a DIFFERENT group (never in this allow-list).
const OTHER_GROUP = chatId(999n);

/** The endpoint's resolved allow-list: exactly the two same-group chats. */
const sameGroupScope = (): ResolvedScope =>
  unwrap(ResolvedScope.create([SRC_IN_GROUP, DST_IN_GROUP]));

/** The exact validated-args shape the forward tool's handler expects. */
type ForwardArgs = Parameters<
  ReturnType<typeof createForwardMessageTool>['handler']
>[1];

const okVoid: Result<void, AppError> = ok(undefined);

interface ForwardHarness {
  readonly useCase: UseCase<ForwardMessageCommand, ForwardResultDto>;
  readonly rateLimiter: StubRateLimiter;
  readonly confirmer: StubConfirmer;
  readonly audit: RecordingAuditLog;
}

/** Wire the real use-case + real ACL evaluator over fake ports. */
const buildForward = (over?: {
  readonly rateLimiter?: StubRateLimiter;
  readonly confirmer?: StubConfirmer;
}): ForwardHarness => {
  const rateLimiter = over?.rateLimiter ?? new StubRateLimiter(okVoid);
  const confirmer = over?.confirmer ?? new StubConfirmer(ok(true));
  const audit = new RecordingAuditLog();
  const useCase = makeWriteUseCase(
    {
      aclEvaluator: new DefaultAclEvaluator(),
      rateLimiter,
      confirmer,
      auditLog: audit,
      clock: new FakeClock(),
    },
    WRITE_SPECS.forwardMessage,
  );
  return { useCase, rateLimiter, confirmer, audit };
};

/**
 * Invoke the forward TOOL handler exactly as the registry would, and expose the
 * spy client so a test can prove the scoped writer was (or was NOT) reached —
 * the load-bearing "fail-closed before the data layer" assertion.
 */
const invokeForwardWith = async (
  harness: ForwardHarness,
  args: ForwardArgs,
  options?: {
    readonly confirmWrites?: boolean;
    readonly verbs?: readonly PermissionVerb[];
    readonly overrides?: ReadonlyMap<string, ReadonlySet<PermissionVerb>>;
  },
): Promise<{
  readonly result: Result<ToolOutput, AppError>;
  readonly client: SpyScopedClient;
}> => {
  const endpoint = buildEndpoint({
    // Forward now needs READ on the source and FORWARD on the destination, so the
    // baseline grant is both (the group-level default for these same-group tests).
    verbs: options?.verbs ?? [PermissionVerb.Read, PermissionVerb.Forward],
    ...(options?.confirmWrites !== undefined
      ? { confirmWrites: options.confirmWrites }
      : {}),
  });
  const client = new SpyScopedClient(endpoint.name);
  const ctx: EndpointExecutionContext = {
    endpoint,
    resolvedScope: sameGroupScope(),
    overrides: options?.overrides ?? new Map(),
    deniedVerbs: NO_DENIED,
    client,
  };
  const tool = createForwardMessageTool(harness.useCase);
  const result = await tool.handler(ctx, args);
  return { result, client };
};

describe('forward_message: same-group only, cross-scope rejected (#1)', () => {
  it('forwards WITHIN the same group when BOTH peers are in the resolved scope', async () => {
    const harness = buildForward();
    const { result, client } = await invokeForwardWith(harness, {
      fromPeer: PeerRefFactory.fromId(SRC_IN_GROUP),
      toPeer: PeerRefFactory.fromId(DST_IN_GROUP),
      messageIds: [1, 2],
    });

    expect(result.ok).toBe(true);
    // The scoped writer WAS reached — and only after the gates passed.
    expect(client.calls).toEqual([
      'resolvePeer',
      'resolvePeer',
      'forwardMessage',
    ]);
    // CQS: the ack carries only safe scalar ids under named keys (#6) — no
    // untrusted Telegram prose leaks through the forward acknowledgement.
    if (result.ok) {
      expect(Object.keys(result.value.structured).sort()).toEqual([
        'forwarded_message_ids',
        'from_chat_id',
        'to_chat_id',
      ]);
    }
    // A permitted forward consumed the dedicated anti-ban bucket (#7).
    expect(harness.rateLimiter.calls).toHaveLength(1);
    expect(harness.rateLimiter.calls[0]?.bucket).toBe('forwards');
    // Audited ALLOW.
    expect(harness.audit.records).toHaveLength(1);
    expect(harness.audit.records[0]?.outcome).toBe('allow');
    expect(harness.audit.records[0]?.verb).toBe(PermissionVerb.Forward);
  });

  it('rejects when the SOURCE peer is out of scope (no read on src) — fail-closed before quota+writer', async () => {
    const harness = buildForward();
    const { result, client } = await invokeForwardWith(harness, {
      fromPeer: PeerRefFactory.fromId(OTHER_GROUP), // source in a DIFFERENT group
      toPeer: PeerRefFactory.fromId(DST_IN_GROUP),
      messageIds: [1],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.AclDenied);
      expect(result.error.cause?.code).toBe(DomainErrorCode.PeerOutOfScope);
    }
    // Doomed request: no quota spent, scoped writer NEVER reached (#1/#7).
    expect(harness.rateLimiter.calls).toEqual([]);
    expect(client.calls).toEqual(['resolvePeer', 'resolvePeer']);
    expect(harness.audit.records[0]?.outcome).toBe('deny');
    expect(harness.audit.records[0]?.reason).toBe(DomainErrorCode.PeerOutOfScope);
  });

  it('rejects when the DESTINATION peer is out of scope (no send on dst) — cross-group forward is impossible', async () => {
    const harness = buildForward();
    const { result, client } = await invokeForwardWith(harness, {
      fromPeer: PeerRefFactory.fromId(SRC_IN_GROUP),
      toPeer: PeerRefFactory.fromId(OTHER_GROUP), // destination in a DIFFERENT group
      messageIds: [7],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.AclDenied);
      expect(result.error.cause?.code).toBe(DomainErrorCode.PeerOutOfScope);
    }
    expect(harness.rateLimiter.calls).toEqual([]);
    expect(client.calls).toEqual(['resolvePeer', 'resolvePeer']);
    expect(harness.audit.records[0]?.outcome).toBe('deny');
  });

  it('rejects when BOTH peers are out of scope (nothing reachable, default-deny)', async () => {
    const harness = buildForward();
    const { result, client } = await invokeForwardWith(harness, {
      fromPeer: PeerRefFactory.fromId(OTHER_GROUP),
      toPeer: PeerRefFactory.fromId(OTHER_GROUP),
      messageIds: [1],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AclDenied);
    expect(harness.rateLimiter.calls).toEqual([]);
    expect(client.calls).toEqual(['resolvePeer', 'resolvePeer']);
  });

  it('forwards in EITHER direction within the group (source/destination are symmetric within one scope)', async () => {
    const harness = buildForward();
    const { result, client } = await invokeForwardWith(harness, {
      fromPeer: PeerRefFactory.fromId(DST_IN_GROUP), // reversed direction
      toPeer: PeerRefFactory.fromId(SRC_IN_GROUP),
      messageIds: [5],
    });

    expect(result.ok).toBe(true);
    expect(client.calls).toEqual([
      'resolvePeer',
      'resolvePeer',
      'forwardMessage',
    ]);
  });
});

describe('forward_message: TWO-SIDED verb rule — read(source) + forward(destination)', () => {
  const READ_ONLY = new Set([PermissionVerb.Read]);
  // A read+write chat carries the whole write tier (incl. forward).
  const READ_WRITE = new Set([
    PermissionVerb.Read,
    PermissionVerb.Send,
    PermissionVerb.Forward,
    PermissionVerb.React,
  ]);

  it('ALLOWS when SOURCE is read-only and DESTINATION is read+write (forward needs read on src, forward on dst)', async () => {
    const harness = buildForward();
    const { result, client } = await invokeForwardWith(
      harness,
      {
        fromPeer: PeerRefFactory.fromId(SRC_IN_GROUP),
        toPeer: PeerRefFactory.fromId(DST_IN_GROUP),
        messageIds: [1],
      },
      {
        overrides: new Map([
          [SRC_IN_GROUP.toKey(), READ_ONLY], // source: read only — enough to READ
          [DST_IN_GROUP.toKey(), READ_WRITE], // destination: carries forward
        ]),
      },
    );

    expect(result.ok).toBe(true);
    expect(client.calls).toEqual(['resolvePeer', 'resolvePeer', 'forwardMessage']);
  });

  it('DENIES when SOURCE is read+write but DESTINATION is read-only (no forward on the destination)', async () => {
    const harness = buildForward();
    const { result, client } = await invokeForwardWith(
      harness,
      {
        fromPeer: PeerRefFactory.fromId(SRC_IN_GROUP),
        toPeer: PeerRefFactory.fromId(DST_IN_GROUP),
        messageIds: [1],
      },
      {
        overrides: new Map([
          [SRC_IN_GROUP.toKey(), READ_WRITE], // source: rw (can read)
          [DST_IN_GROUP.toKey(), READ_ONLY], // destination: read only — cannot be forwarded INTO
        ]),
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.AclDenied);
      expect(result.error.cause?.code).toBe(DomainErrorCode.VerbNotGranted);
    }
    // Fail-closed at the destination's forward gate — the writer is never reached.
    expect(harness.rateLimiter.calls).toEqual([]);
    expect(client.calls).toEqual(['resolvePeer', 'resolvePeer']);
    // The deny audit pins the FAILING side (the destination).
    expect(harness.audit.records[0]?.outcome).toBe('deny');
    expect(harness.audit.records[0]?.targetChatId).toBe(DST_IN_GROUP.toKey());
  });
});

describe('forward_message: STATIC menu, execution is the ACL (#3/#4)', () => {
  it('the STATIC registry lists forward_message for EVERY endpoint (even read-only, even kill-switched)', () => {
    const tool = createForwardMessageTool(buildForward().useCase);

    const onForwardEndpoint = buildEndpoint({ verbs: [PermissionVerb.Forward] });
    const exposedForForward = buildEndpointServer({
      definitions: [tool],
      contextProvider: (): Promise<Result<EndpointExecutionContext, AppError>> =>
        Promise.resolve(
          ok({
            endpoint: onForwardEndpoint,
            resolvedScope: resolvedScope(),
            overrides: new Map(),
            deniedVerbs: NO_DENIED,
            client: new SpyScopedClient(onForwardEndpoint.name),
          }),
        ),
    }).toolNames;
    expect(exposedForForward).toEqual(['forward_message']);

    // A read-only endpoint STILL lists it (the menu is discovery; EXECUTION denies).
    const onReadEndpoint = buildEndpoint({ verbs: [PermissionVerb.Read] });
    const exposedForRead = buildEndpointServer({
      definitions: [tool],
      contextProvider: (): Promise<Result<EndpointExecutionContext, AppError>> =>
        Promise.resolve(
          ok({
            endpoint: onReadEndpoint,
            resolvedScope: resolvedScope(),
            overrides: new Map(),
            deniedVerbs: NO_DENIED,
            client: new SpyScopedClient(onReadEndpoint.name),
          }),
        ),
    }).toolNames;
    expect(exposedForRead).toEqual(['forward_message']);
  });

  it('a kill-switched endpoint STILL lists `forward_message` (kill-switch is enforced at execution, not the menu)', () => {
    const tool = createForwardMessageTool(buildForward().useCase);
    const endpoint = buildEndpoint({ verbs: [PermissionVerb.Forward] });
    const exposed = buildEndpointServer({
      definitions: [tool],
      contextProvider: (): Promise<Result<EndpointExecutionContext, AppError>> =>
        Promise.resolve(
          ok({
            endpoint,
            resolvedScope: resolvedScope(),
            overrides: new Map(),
            deniedVerbs: NO_DENIED,
            client: new SpyScopedClient(endpoint.name),
          }),
        ),
    }).toolNames;
    expect(exposed).toEqual(['forward_message']);
  });

  it('denies at the use-case verb-gate even if the handler is reached on a non-`forward` endpoint (defense in depth)', async () => {
    const harness = buildForward();
    // Both peers are perfectly in scope, but the endpoint does NOT grant `forward`.
    const { result, client } = await invokeForwardWith(
      harness,
      {
        fromPeer: PeerRefFactory.fromId(SRC_IN_GROUP),
        toPeer: PeerRefFactory.fromId(DST_IN_GROUP),
        messageIds: [1],
      },
      { verbs: [PermissionVerb.Read] },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.AclDenied);
      expect(result.error.cause?.code).toBe(DomainErrorCode.VerbNotGranted);
    }
    // Verb-gate fails closed BEFORE quota and BEFORE the writer.
    expect(harness.rateLimiter.calls).toEqual([]);
    expect(client.calls).toEqual(['resolvePeer', 'resolvePeer']);
  });
});

describe('forward_message: write is HITL-guarded (#8)', () => {
  it('a declined human confirmation fails the forward closed (writer never reached)', async () => {
    const harness = buildForward({ confirmer: new StubConfirmer(ok(false)) });
    const { result, client } = await invokeForwardWith(
      harness,
      {
        fromPeer: PeerRefFactory.fromId(SRC_IN_GROUP),
        toPeer: PeerRefFactory.fromId(DST_IN_GROUP),
        messageIds: [1],
      },
      { confirmWrites: true },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.ConfirmationRequired);
    }
    expect(harness.confirmer.calls).toHaveLength(1);
    expect(harness.confirmer.calls[0]?.verb).toBe(PermissionVerb.Forward);
    expect(client.calls).toEqual(['resolvePeer', 'resolvePeer']);
    // HITL runs BEFORE quota, so a declined write spends NO anti-ban quota (the
    // RateLimiter port has no refund): tryConsume is never called.
    expect(harness.rateLimiter.calls).toEqual([]);
  });

  it('an exhausted `forwards` quota blocks the forward at the writer, AFTER a positive HITL (#7)', async () => {
    // Quota gates the real Telegram dispatch, so it runs AFTER HITL: a human is
    // asked first (their approval is cheap and consumes no account resource), and
    // only then does the anti-ban quota refuse the actual send. This ordering is
    // what lets a DECLINED write cost zero quota (asserted above) while still
    // capping dispatched forwards.
    const harness = buildForward({
      rateLimiter: new StubRateLimiter(
        err(
          appError(AppErrorCode.QuotaExceeded, 'slow down', {
            retryAfterSeconds: 42,
          }),
        ),
      ),
      confirmer: new StubConfirmer(ok(true)),
    });
    const { result, client } = await invokeForwardWith(
      harness,
      {
        fromPeer: PeerRefFactory.fromId(SRC_IN_GROUP),
        toPeer: PeerRefFactory.fromId(DST_IN_GROUP),
        messageIds: [1],
      },
      { confirmWrites: true },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.QuotaExceeded);
      expect(result.error.retryAfterSeconds).toBe(42);
    }
    // The human WAS consulted (HITL-before-quota), the quota then refused, and the
    // writer was never reached.
    expect(harness.confirmer.calls).toHaveLength(1);
    expect(client.calls).toEqual(['resolvePeer', 'resolvePeer']);
  });
});
