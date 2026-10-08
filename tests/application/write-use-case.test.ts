/**
 * Write-tier use-case orchestration: resolve -> ACL -> HITL (#8) -> quota (#7)
 * -> writer -> audit (#8), with fail-closed ordering. Mocked ports assert WHICH gate
 * stopped a request and that doomed requests never spend quota or reach the
 * writer.
 */
import { describe, it, expect } from 'vitest';
import { ok, err, unwrap, type Result } from '../../src/shared/result.js';
import { PeerRefFactory, ResolvedScope } from '../../src/domain/index.js';
import { DefaultAclEvaluator } from '../../src/domain/index.js';
import { AppErrorCode, appError, type AppError } from '../../src/application/errors.js';
import {
  PermissionVerb,
} from '../../src/domain/index.js';
import {
  makeWriteUseCase,
  WRITE_SPECS,
} from '../../src/application/use-cases/write-use-case-impls.js';
import type { EndpointExecutionContext } from '../../src/application/use-cases/context.js';
import {
  buildEndpoint,
  resolvedScope,
  FakeClock,
  RecordingAuditLog,
  StubRateLimiter,
  StubConfirmer,
  SpyScopedClient,
  IN_SCOPE,
  OUT_OF_SCOPE,
  chatId,
  NO_DENIED,
} from './_support.js';
import type { PermissionVerb as PermissionVerbType } from '../../src/domain/index.js';

const okVoid: Result<void, AppError> = ok(undefined);

const ctxFor = (
  client: SpyScopedClient,
  confirmWrites: boolean,
  denied: ReadonlySet<PermissionVerbType> = NO_DENIED,
): EndpointExecutionContext => {
  const endpoint = buildEndpoint({ verbs: [PermissionVerb.Send], confirmWrites });
  return {
    endpoint,
    resolvedScope: resolvedScope(),
    overrides: new Map(),
    deniedVerbs: denied,
    client,
  };
};

const deps = (over: {
  readonly rateLimiter?: StubRateLimiter;
  readonly confirmer?: StubConfirmer;
  readonly audit?: RecordingAuditLog;
}): {
  aclEvaluator: DefaultAclEvaluator;
  rateLimiter: StubRateLimiter;
  confirmer: StubConfirmer;
  auditLog: RecordingAuditLog;
  clock: FakeClock;
} => ({
  aclEvaluator: new DefaultAclEvaluator(),
  rateLimiter: over.rateLimiter ?? new StubRateLimiter(okVoid),
  confirmer: over.confirmer ?? new StubConfirmer(ok(true)),
  auditLog: over.audit ?? new RecordingAuditLog(),
  clock: new FakeClock(),
});

describe('SendMessage — per-chat verb override ENFORCEMENT (the wiring the audit flagged)', () => {
  it('allows the me alias when it resolves to a chat carrying a Send override above a read-only group', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const audit = new RecordingAuditLog();
    const uc = makeWriteUseCase(deps({ audit }), WRITE_SPECS.sendMessage);
    const ctx: EndpointExecutionContext = {
      endpoint: buildEndpoint({ verbs: [PermissionVerb.Read] }),
      resolvedScope: resolvedScope(),
      overrides: new Map([
        [IN_SCOPE.toKey(), new Set([PermissionVerb.Read, PermissionVerb.Send])],
      ]),
      deniedVerbs: NO_DENIED,
      client,
    };

    const result = await uc.execute(ctx, {
      peer: PeerRefFactory.me(),
      text: 'allowed via canonical self id',
    });

    expect(result.ok).toBe(true);
    expect(client.calls).toEqual(['resolvePeer', 'sendMessage']);
    expect(audit.records[0]?.outcome).toBe('allow');
    expect(audit.records[0]?.targetChatId).toBe(IN_SCOPE.toKey());
  });

  it('allows a username alias only when that exact resolved chat carries the Send override', async () => {
    const username = unwrap(PeerRefFactory.fromUsername('@reader'));
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const uc = makeWriteUseCase(deps({}), WRITE_SPECS.sendMessage);
    const ctx: EndpointExecutionContext = {
      endpoint: buildEndpoint({ verbs: [PermissionVerb.Read] }),
      resolvedScope: resolvedScope(),
      overrides: new Map([
        [IN_SCOPE.toKey(), new Set([PermissionVerb.Read, PermissionVerb.Send])],
      ]),
      deniedVerbs: NO_DENIED,
      client,
    };

    const result = await uc.execute(ctx, {
      peer: username,
      text: 'allowed via canonical username id',
    });

    expect(result.ok).toBe(true);
    expect(client.calls).toEqual(['resolvePeer', 'sendMessage']);
  });

  it('does not let a username alias borrow another in-scope chat’s Send override', async () => {
    const other = chatId(101n);
    const username = unwrap(PeerRefFactory.fromUsername('@reader'));
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name, () =>
      ok(other),
    );
    const rateLimiter = new StubRateLimiter(okVoid);
    const uc = makeWriteUseCase(deps({ rateLimiter }), WRITE_SPECS.sendMessage);
    const ctx: EndpointExecutionContext = {
      endpoint: buildEndpoint({ verbs: [PermissionVerb.Read] }),
      resolvedScope: unwrap(ResolvedScope.create([IN_SCOPE, other])),
      overrides: new Map([
        [IN_SCOPE.toKey(), new Set([PermissionVerb.Read, PermissionVerb.Send])],
      ]),
      deniedVerbs: NO_DENIED,
      client,
    };

    const result = await uc.execute(ctx, {
      peer: username,
      text: 'must not borrow another chat override',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AclDenied);
    expect(rateLimiter.calls).toEqual([]);
    expect(client.calls).toEqual(['resolvePeer']);
  });

  it('a narrowing override (chat read-only inside a send-granted endpoint) DENIES the write and never reaches the writer', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const audit = new RecordingAuditLog();
    const uc = makeWriteUseCase(deps({ audit }), WRITE_SPECS.sendMessage);

    // Group grants Send, but IN_SCOPE carries a read-only override: send must deny.
    const ctx: EndpointExecutionContext = {
      endpoint: buildEndpoint({ verbs: [PermissionVerb.Send] }),
      resolvedScope: resolvedScope(),
      overrides: new Map([[IN_SCOPE.toKey(), new Set([PermissionVerb.Read])]]),
      deniedVerbs: NO_DENIED,
      client,
    };

    const result = await uc.execute(ctx, {
      peer: PeerRefFactory.fromId(IN_SCOPE),
      text: 'blocked by the override',
    });

    expect(result.ok).toBe(false);
    expect(client.calls).toEqual(['resolvePeer']); // never reached the writer
    expect(audit.records[0]?.outcome).toBe('deny');
  });

  it('an escalating override still requires the peer be IN scope (override never widens scope)', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const uc = makeWriteUseCase(deps({}), WRITE_SPECS.sendMessage);
    const ctx: EndpointExecutionContext = {
      endpoint: buildEndpoint({ verbs: [PermissionVerb.Send] }),
      resolvedScope: resolvedScope(),
      overrides: new Map([[OUT_OF_SCOPE.toKey(), new Set([PermissionVerb.Send])]]),
      deniedVerbs: NO_DENIED,
      client,
    };
    const result = await uc.execute(ctx, {
      peer: PeerRefFactory.fromId(OUT_OF_SCOPE),
      text: 'still out of scope',
    });
    expect(result.ok).toBe(false);
    expect(client.calls).toEqual(['resolvePeer']);
  });
});

describe('SendMessage use-case orchestration', () => {
  it('happy path: writer called, audit ALLOW with echoed idempotency key', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const audit = new RecordingAuditLog();
    const uc = makeWriteUseCase(deps({ audit }), WRITE_SPECS.sendMessage);

    const result = await uc.execute(ctxFor(client, false), {
      peer: PeerRefFactory.fromId(IN_SCOPE),
      text: 'hello',
    });

    expect(result.ok).toBe(true);
    expect(client.calls).toEqual(['resolvePeer', 'sendMessage']);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]?.outcome).toBe('allow');
    expect(audit.records[0]?.idempotencyKey).toBe('gateway-minted-key');
  });

  it('a kill-switched verb DENIES at the ACL step BEFORE HITL + quota (static menu still lists the tool)', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const rateLimiter = new StubRateLimiter(okVoid);
    const confirmer = new StubConfirmer(ok(true));
    const audit = new RecordingAuditLog();
    const uc = makeWriteUseCase(deps({ rateLimiter, confirmer, audit }), WRITE_SPECS.sendMessage);

    // Send is granted by the group, but daemon-denied (kill-switched) for this call.
    const ctx = ctxFor(
      client,
      true,
      new Set([PermissionVerb.Send]),
    );
    const result = await uc.execute(ctx, {
      peer: PeerRefFactory.fromId(IN_SCOPE),
      text: 'hello',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AclDenied);
    // Denied at the ACL step: no HITL prompt, no quota token, no writer call.
    expect(confirmer.calls).toEqual([]);
    expect(rateLimiter.calls).toEqual([]);
    expect(client.calls).toEqual(['resolvePeer']);
    expect(audit.records[0]?.outcome).toBe('deny');
  });

  it('ACL deny (out-of-scope) short-circuits BEFORE quota + writer', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const rateLimiter = new StubRateLimiter(okVoid);
    const audit = new RecordingAuditLog();
    const uc = makeWriteUseCase(deps({ rateLimiter, audit }), WRITE_SPECS.sendMessage);

    const result = await uc.execute(ctxFor(client, false), {
      peer: PeerRefFactory.fromId(OUT_OF_SCOPE),
      text: 'hello',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AclDenied);
    expect(rateLimiter.calls).toEqual([]); // no quota spent on a doomed request
    expect(client.calls).toEqual(['resolvePeer']);
    expect(audit.records[0]?.outcome).toBe('deny');
  });

  it('quota exhausted: writer not reached, QUOTA_EXCEEDED surfaced', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const rateLimiter = new StubRateLimiter(
      err(
        appError(AppErrorCode.QuotaExceeded, 'slow down', {
          retryAfterSeconds: 30,
        }),
      ),
    );
    const confirmer = new StubConfirmer(ok(true));
    const uc = makeWriteUseCase(deps({ rateLimiter, confirmer }), WRITE_SPECS.sendMessage);

    const result = await uc.execute(ctxFor(client, false), {
      peer: PeerRefFactory.fromId(IN_SCOPE),
      text: 'hello',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.QuotaExceeded);
      expect(result.error.retryAfterSeconds).toBe(30);
    }
    expect(confirmer.calls).toEqual([]); // never prompted a human for a rate-limited send
    expect(client.calls).toEqual(['resolvePeer']);
  });

  it('HITL declined: writer not reached, CONFIRMATION_REQUIRED surfaced', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const confirmer = new StubConfirmer(ok(false));
    const uc = makeWriteUseCase(deps({ confirmer }), WRITE_SPECS.sendMessage);

    const result = await uc.execute(
      ctxFor(client, true),
      { peer: PeerRefFactory.fromId(IN_SCOPE), text: 'hello' },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.ConfirmationRequired);
    }
    expect(confirmer.calls).toHaveLength(1);
    expect(client.calls).toEqual(['resolvePeer']);
  });

  it('HITL declined spends NO anti-ban quota (HITL is gated BEFORE quota)', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const rateLimiter = new StubRateLimiter(okVoid);
    const confirmer = new StubConfirmer(ok(false));
    const uc = makeWriteUseCase(deps({ rateLimiter, confirmer }), WRITE_SPECS.sendMessage);

    const result = await uc.execute(ctxFor(client, true), {
      peer: PeerRefFactory.fromId(IN_SCOPE),
      text: 'hello',
    });

    expect(result.ok).toBe(false);
    // A declined write never reaches Telegram, so it must NOT burn quota (the
    // port has no refund): tryConsume is never called.
    expect(rateLimiter.calls).toEqual([]);
    expect(client.calls).toEqual(['resolvePeer']);
  });

  it('HITL unavailable spends NO anti-ban quota', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const rateLimiter = new StubRateLimiter(okVoid);
    const confirmer = new StubConfirmer(
      err(appError(AppErrorCode.ConfirmationRequired, 'no elicitation channel')),
    );
    const uc = makeWriteUseCase(deps({ rateLimiter, confirmer }), WRITE_SPECS.sendMessage);

    const result = await uc.execute(ctxFor(client, true), {
      peer: PeerRefFactory.fromId(IN_SCOPE),
      text: 'hello',
    });

    expect(result.ok).toBe(false);
    expect(rateLimiter.calls).toEqual([]);
    expect(client.calls).toEqual(['resolvePeer']);
  });

  it('a confirmed write consumes exactly one quota token keyed by sessionRef', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const rateLimiter = new StubRateLimiter(okVoid);
    const confirmer = new StubConfirmer(ok(true));
    const ctx = ctxFor(client, true);
    const uc = makeWriteUseCase(deps({ rateLimiter, confirmer }), WRITE_SPECS.sendMessage);

    const result = await uc.execute(ctx, {
      peer: PeerRefFactory.fromId(IN_SCOPE),
      text: 'hello',
    });

    expect(result.ok).toBe(true);
    expect(rateLimiter.calls).toHaveLength(1);
    // The anti-ban partition key is the SESSION, not the endpoint name.
    expect(rateLimiter.calls[0]?.sessionRef).toBe(ctx.endpoint.sessionRef);
    expect(client.calls).toEqual(['resolvePeer', 'sendMessage']);
  });

  it('HITL is consulted only when the policy requires it for the verb', async () => {
    const client = new SpyScopedClient(buildEndpoint({ verbs: [] }).name);
    const confirmer = new StubConfirmer(ok(true));
    const uc = makeWriteUseCase(deps({ confirmer }), WRITE_SPECS.sendMessage);

    await uc.execute(ctxFor(client, false), {
      peer: PeerRefFactory.fromId(IN_SCOPE),
      text: 'hello',
    });

    expect(confirmer.calls).toEqual([]); // confirmWrites=false -> no prompt
    expect(client.calls).toEqual(['resolvePeer', 'sendMessage']);
  });
});

describe('Forward use-case scopes BOTH peers', () => {
  it('denies when the destination peer is out of scope', async () => {
    const endpoint = buildEndpoint({ verbs: [PermissionVerb.Forward] });
    const client = new SpyScopedClient(endpoint.name);
    const rateLimiter = new StubRateLimiter(okVoid);
    const uc = makeWriteUseCase(deps({ rateLimiter }), WRITE_SPECS.forwardMessage);

    const result = await uc.execute(
      {
        endpoint,
        resolvedScope: resolvedScope(),
        overrides: new Map(),
        deniedVerbs: NO_DENIED,
        client,
      },
      {
        fromPeer: PeerRefFactory.fromId(IN_SCOPE),
        toPeer: PeerRefFactory.fromId(OUT_OF_SCOPE),
        messageIds: [1],
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(AppErrorCode.AclDenied);
    expect(rateLimiter.calls).toEqual([]);
    expect(client.calls).toEqual(['resolvePeer', 'resolvePeer']);
  });
});
